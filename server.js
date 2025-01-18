// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const twilio = require('twilio');
const { OpenAI } = require('openai');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB Connected...');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  }
};

connectDB();

// Initialize Twilio and OpenAI
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Interview Schema
const interviewSchema = new mongoose.Schema({
  phoneNumber: String,
  topic: String,
  status: String,
  callSid: String,
  responses: [{
    question: String,
    answer: String,
    timestamp: { type: Date, default: Date.now }
  }],
  createdAt: { type: Date, default: Date.now }
});

const Interview = mongoose.model('Interview', interviewSchema);

// Interview state management
const activeInterviews = new Map();

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date() });
});

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New WebSocket connection established');

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      console.log('Received WebSocket message:', data);
      
      if (data.type === 'START_INTERVIEW') {
        // Validate phone number format
        const phoneRegex = /^\+?[1-9]\d{1,14}$/;
        if (!phoneRegex.test(data.phoneNumber)) {
          throw new Error('Invalid phone number format');
        }

        // Create new interview record
        const interview = new Interview({
          phoneNumber: data.phoneNumber,
          topic: data.topic,
          status: 'starting'
        });
        await interview.save();
        
        console.log('Creating Twilio call with URL:', `${process.env.BASE_URL}/voice`);
        
        // Initialize phone call
        const call = await twilioClient.calls.create({
          url: `${process.env.BASE_URL}/voice`,
          to: data.phoneNumber,
          from: process.env.TWILIO_PHONE_NUMBER,
          statusCallback: `${process.env.BASE_URL}/call-status`,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
        });
        
        // Update interview with callSid
        interview.callSid = call.sid;
        interview.status = 'in-progress';
        await interview.save();

        console.log('Twilio call created:', call.sid);
        
        // Initialize interview state
        activeInterviews.set(call.sid, {
          questions: [],
          answers: [],
          currentQuestion: 0,
          interviewId: interview._id
        });

        ws.send(JSON.stringify({
          type: 'INTERVIEW_STARTED',
          interviewId: interview._id,
          callSid: call.sid
        }));
      }
    } catch (error) {
      console.error('Error in WebSocket message handling:', error);
      ws.send(JSON.stringify({
        type: 'ERROR',
        message: error.message || 'Failed to start interview'
      }));
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
  });
});

// Voice endpoint for Twilio
app.post('/voice', async (req, res) => {
  try {
    const twiml = new twilio.twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    
    if (!activeInterviews.has(callSid)) {
      // Initial greeting
      const interview = await Interview.findOne({ callSid });
      if (!interview) {
        throw new Error('Interview not found');
      }

      activeInterviews.set(callSid, {
        questions: [],
        answers: [],
        currentQuestion: 0,
        interviewId: interview._id
      });

      twiml.say(
        { voice: 'alice' },
        `Hello! I'll be conducting your interview about ${interview.topic}. Let's begin.`
      );
      twiml.pause({ length: 1 });
    }

    const interview = activeInterviews.get(callSid);
    
    // Generate question using OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{
        role: "system",
        content: `You are conducting a professional interview. Previous questions: ${interview.questions.join(', ')}. 
                  Previous answers: ${interview.answers.join(', ')}. 
                  Generate a relevant follow-up question. Keep it concise and clear.`
      }]
    });

    const question = completion.choices[0].message.content;
    interview.questions.push(question);
    
    twiml.say({ voice: 'alice' }, question);
    twiml.record({
      action: '/handle-response',
      maxLength: 90,
      transcribe: true,
      transcribeCallback: '/transcription-callback'
    });

    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('Error in voice endpoint:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(
      { voice: 'alice' },
      'I apologize, but we encountered an unexpected error. Please try again later.'
    );
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Handle recorded response
app.post('/handle-response', async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callSid = req.body.CallSid;
  
  try {
    const interview = activeInterviews.get(callSid);
    
    if (!interview) {
      throw new Error('Interview session not found');
    }

    if (interview.currentQuestion >= 4) { // Limit to 5 questions
      twiml.say(
        { voice: 'alice' },
        'Thank you for completing the interview. We appreciate your time.'
      );
      twiml.hangup();
      
      // Update interview status
      await Interview.findByIdAndUpdate(interview.interviewId, {
        status: 'completed'
      });
      
      activeInterviews.delete(callSid);
    } else {
      interview.currentQuestion++;
      twiml.pause({ length: 1 });
      twiml.redirect('/voice');
    }
  } catch (error) {
    console.error('Error in handle-response:', error);
    twiml.say(
      { voice: 'alice' },
      'I apologize, but we encountered an error. The interview will now end.'
    );
    twiml.hangup();
  }
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// Handle transcription callback
app.post('/transcription-callback', async (req, res) => {
  const callSid = req.body.CallSid;
  const transcription = req.body.TranscriptionText;
  
  try {
    const interview = activeInterviews.get(callSid);
    
    if (interview) {
      interview.answers.push(transcription);
      
      // Save to database
      await Interview.findByIdAndUpdate(
        interview.interviewId,
        { 
          $push: { 
            responses: {
              question: interview.questions[interview.currentQuestion - 1],
              answer: transcription
            }
          }
        }
      );
      
      // Notify connected WebSocket clients
      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: 'INTERVIEW_UPDATE',
            callSid: callSid,
            question: interview.questions[interview.currentQuestion - 1],
            answer: transcription
          }));
        }
      });
    }
  } catch (error) {
    console.error('Error in transcription-callback:', error);
  }
  
  res.sendStatus(200);
});

// Call status webhook
app.post('/call-status', async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;
  
  try {
    console.log(`Call ${callSid} status updated to: ${callStatus}`);
    
    if (callStatus === 'completed' || callStatus === 'failed') {
      const interview = await Interview.findOne({ callSid });
      if (interview) {
        interview.status = callStatus === 'completed' ? 'completed' : 'failed';
        await interview.save();
        
        // Cleanup
        activeInterviews.delete(callSid);
      }
    }
  } catch (error) {
    console.error('Error in call-status webhook:', error);
  }
  
  res.sendStatus(200);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Start server
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  server.close(() => {
    mongoose.connection.close();
    console.log('Server shut down gracefully');
  });
});