const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files for testing
app.use(express.static('public'));

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
fs.ensureDirSync(uploadsDir);

// In-memory storage for sessions (in production, use a database)
const sessions = new Map();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.params.sessionId;
    const sessionDir = path.join(uploadsDir, sessionId);
    fs.ensureDirSync(sessionDir);
    cb(null, sessionDir);
  },
  filename: (req, file, cb) => {
    const chunkNumber = req.params.chunkNumber;
    cb(null, `chunk_${chunkNumber}.wav`);
  }
});

const upload = multer({ storage: storage });

// Helper function to generate session ID in test_123 format
function generateSessionId() {
  const randomNum = Math.floor(Math.random() * 1000);
  return `test_${randomNum.toString().padStart(3, '0')}`;
}

// POST /upload-session - Create a new recording session
app.post('/upload-session', (req, res) => {
  try {
    const sessionId = generateSessionId();
    const sessionData = {
      sessionId,
      createdAt: new Date().toISOString(),
      status: 'active',
      chunks: [],
      totalChunks: 0
    };
    
    sessions.set(sessionId, sessionData);
    
    console.log(`Created new session: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      message: 'Session created successfully'
    });
  } catch (error) {
    console.error('Error creating session:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create session'
    });
  }
});

// POST /get-presigned-url - Get upload URL for audio chunks
app.post('/get-presigned-url', (req, res) => {
  try {
    const { sessionId, chunkNumber } = req.body;
    
    if (!sessionId || chunkNumber === undefined) {
      return res.status(400).json({
        success: false,
        message: 'sessionId and chunkNumber are required'
      });
    }
    
    if (!sessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    // Generate presigned URL (force HTTPS for production)
    const protocol = req.get('x-forwarded-proto') || req.protocol || 'https';
    const presignedUrl = `${protocol}://${req.get('host')}/upload-chunk/${sessionId}/${chunkNumber}`;
    
    console.log(`Generated presigned URL for session ${sessionId}, chunk ${chunkNumber}`);
    
    res.json({
      success: true,
      presignedUrl,
      sessionId,
      chunkNumber,
      expiresIn: 3600 // 1 hour
    });
  } catch (error) {
    console.error('Error generating presigned URL:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate presigned URL'
    });
  }
});

// POST /upload-chunk/:sessionId/:chunkNumber - Upload audio chunk
app.post('/upload-chunk/:sessionId/:chunkNumber', upload.single('audio'), (req, res) => {
  try {
    const { sessionId, chunkNumber } = req.params;
    
    if (!sessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No audio file uploaded'
      });
    }
    
    const session = sessions.get(sessionId);
    const chunkNum = parseInt(chunkNumber);
    
    // Check if chunk already exists
    const existingChunk = session.chunks.find(c => c.chunkNumber === chunkNum);
    if (existingChunk) {
      console.log(`Chunk ${chunkNumber} already exists for session ${sessionId}, skipping upload`);
      return res.json({
        success: true,
        sessionId,
        chunkNumber: chunkNum,
        filename: existingChunk.filename,
        size: existingChunk.size,
        message: 'Chunk already exists, skipped upload'
      });
    }
    
    const chunkInfo = {
      chunkNumber: chunkNum,
      filename: req.file.filename,
      size: req.file.size,
      uploadedAt: new Date().toISOString(),
      path: req.file.path
    };
    
    // Add chunk to session
    session.chunks.push(chunkInfo);
    session.totalChunks = session.chunks.length;
    sessions.set(sessionId, session);
    
    console.log(`Uploaded chunk ${chunkNumber} for session ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      chunkNumber: chunkNum,
      filename: req.file.filename,
      size: req.file.size,
      message: 'Chunk uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading chunk:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload chunk'
    });
  }
});

// POST /notify-chunk-uploaded - Confirm chunk receipt
app.post('/notify-chunk-uploaded', (req, res) => {
  try {
    const { sessionId, chunkNumber, checksum } = req.body;
    
    if (!sessionId || chunkNumber === undefined) {
      return res.status(400).json({
        success: false,
        message: 'sessionId and chunkNumber are required'
      });
    }
    
    if (!sessions.has(sessionId)) {
      return res.status(404).json({
        success: false,
        message: 'Session not found'
      });
    }
    
    const session = sessions.get(sessionId);
    const chunk = session.chunks.find(c => c.chunkNumber === parseInt(chunkNumber));
    
    if (!chunk) {
      return res.status(404).json({
        success: false,
        message: 'Chunk not found'
      });
    }
    
    // Mark chunk as confirmed
    chunk.confirmed = true;
    chunk.confirmedAt = new Date().toISOString();
    if (checksum) {
      chunk.checksum = checksum;
    }
    
    sessions.set(sessionId, session);
    
    console.log(`Confirmed chunk ${chunkNumber} for session ${sessionId}`);
    
    res.json({
      success: true,
      sessionId,
      chunkNumber,
      confirmed: true,
      message: 'Chunk receipt confirmed'
    });
  } catch (error) {
    console.error('Error confirming chunk:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to confirm chunk receipt'
    });
  }
});

// GET /all-session - Get all session data
app.get('/all-session', (req, res) => {
  try {
    const allSessions = Array.from(sessions.values());
    
    console.log(`Retrieved ${allSessions.length} sessions`);
    
    res.json({
      success: true,
      sessions: allSessions,
      totalSessions: allSessions.length
    });
  } catch (error) {
    console.error('Error retrieving sessions:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to retrieve sessions'
    });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Medical Transcription API is running',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`Medical Transcription API server running on port ${port}`);
  console.log(`Server started at ${new Date().toISOString()}`);
  console.log(`🌐 Web interface available at: http://localhost:${port}`);
  console.log('Available endpoints:');
  console.log('  GET  / (Web interface for browsing audio files)');
  console.log('  POST /upload-session');
  console.log('  POST /get-presigned-url');
  console.log('  POST /upload-chunk/:sessionId/:chunkNumber');
  console.log('  POST /notify-chunk-uploaded');
  console.log('  GET  /all-session');
  console.log('  GET  /health');
});
