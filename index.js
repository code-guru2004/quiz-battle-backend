import express from "express";
import { Server } from "socket.io";
import http from "http";
import cors from "cors";
import { questions } from "./question.js";

const PORT = process.env.PORT || 3000;
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ["GET", "POST"]
  },
});

const rooms = {};

// Utility function to shuffle array using Fisher-Yates algorithm
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// Combined approach: Weighted selection from shuffled buckets
class QuestionSelector {
  constructor(allQuestions) {
    this.allQuestions = allQuestions;
    this.questionPool = []; // Current active pool
    this.usedQuestions = new Set(); // Questions used in current session
    this.backupPool = []; // Backup pool for reshuffling
    this.initializePools();
  }

  initializePools() {
    // Create initial shuffled pool
    this.questionPool = shuffleArray([...this.allQuestions]);
    // Create backup pool from remaining questions
    this.backupPool = shuffleArray([...this.allQuestions]);
  }

  getNextQuestion() {
    // If pool is getting low, refresh it
    if (this.questionPool.length < 3) {
      this.refreshPool();
    }

    // Apply weights based on usage
    const weights = this.calculateWeights();
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    let random = Math.random() * totalWeight;
    
    let selectedIndex = 0;
    for (let i = 0; i < weights.length; i++) {
      random -= weights[i];
      if (random <= 0) {
        selectedIndex = i;
        break;
      }
    }

    const selectedQuestion = this.questionPool[selectedIndex];
    
    // Mark as used and remove from current pool
    this.usedQuestions.add(selectedQuestion);
    this.questionPool.splice(selectedIndex, 1);

    return selectedQuestion;
  }

  calculateWeights() {
    // Weight calculation based on multiple factors
    return this.questionPool.map((question, index) => {
      let weight = 100; // Base weight
      
      // Reduce weight for questions used recently
      if (this.usedQuestions.has(question)) {
        weight *= 0.1; // Heavily penalize recently used questions
      }
      
      // Slight preference for middle of pool (avoid edge bias)
      const positionFactor = 1 - Math.abs((index / this.questionPool.length) - 0.5) * 0.2;
      weight *= positionFactor;
      
      // Small random variation
      weight *= (0.9 + Math.random() * 0.2);
      
      return Math.max(10, weight); // Ensure minimum weight
    });
  }

  refreshPool() {
    // Move some questions from backup to active pool
    const questionsToAdd = Math.min(5, this.backupPool.length);
    
    for (let i = 0; i < questionsToAdd; i++) {
      if (this.backupPool.length > 0) {
        const question = this.backupPool.shift();
        // Only add if not recently used
        if (!this.usedQuestions.has(question)) {
          this.questionPool.push(question);
        }
      }
    }
    
    // Shuffle the refreshed pool
    this.questionPool = shuffleArray(this.questionPool);
    
    // If backup pool is empty, reset everything
    if (this.backupPool.length === 0) {
      this.resetPools();
    }
  }

  resetPools() {
    // Clear used questions after a full cycle
    this.usedQuestions.clear();
    // Reinitialize both pools
    const allShuffled = shuffleArray([...this.allQuestions]);
    const midPoint = Math.floor(allShuffled.length / 2);
    this.questionPool = allShuffled.slice(0, midPoint);
    this.backupPool = allShuffled.slice(midPoint);
  }
}

// ... (previous imports and setup remain the same)

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join-room", ({ roomCode, username }) => {
    socket.join(roomCode);

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        players: [],
        users: {},
        questionSelector: new QuestionSelector(questions),
        answers: {},
        scores: {},
        round: 0,
        currentQuestion: null // Add this to store current question
      };
    }

    const room = rooms[roomCode];

    if (room.players.length < 2) {
      room.players.push(socket.id);
      room.users[socket.id] = username;
      room.scores[socket.id] = 0;
    }

    io.to(roomCode).emit("players", room.users);

    if (room.players.length === 2) {
      startQuestion(roomCode);
    }
  });

  socket.on("submit-answer", ({ roomCode, answer }) => {
    const room = rooms[roomCode];
    if (!room) return;
    room.answers[socket.id] = answer;
  });

  socket.on("disconnect", () => {
    console.log("Disconnected:", socket.id);
  });
});

function startQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  
  room.answers = {};
  room.round += 1;

  // Get next question and STORE IT in room state
  room.currentQuestion = room.questionSelector.getNextQuestion();

  io.to(roomCode).emit("new-question", {
    question: room.currentQuestion.question,
    options: room.currentQuestion.options,
    time: room.currentQuestion.time || 30,
    round: room.round
  });

  setTimeout(() => endQuestion(roomCode), (room.currentQuestion.time || 30) * 1000);
}

function endQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.currentQuestion) return;
  
  const currentQuestion = room.currentQuestion;
  const correctAnswer = currentQuestion.answer;
  
  // Create an object to track correctness for each player
  const playerResults = {};
  const correctPlayers = [];
  const incorrectPlayers = [];

  // Calculate scores and track correctness
  for (let playerId of room.players) {
    const playerAnswer = room.answers[playerId];
    const isCorrect = playerAnswer === correctAnswer;
    
    // Track result for this player
    playerResults[playerId] = {
      username: room.users[playerId],
      answer: playerAnswer,
      isCorrect: isCorrect,
      scoreChange: isCorrect ? 1 : 0
    };
    
    // Update scores
    if (isCorrect) {
      room.scores[playerId] = (room.scores[playerId] || 0) + 1;
      correctPlayers.push(room.users[playerId]);
    } else {
      incorrectPlayers.push(room.users[playerId]);
    }
  }
  
  // Send detailed results to all players
  io.to(roomCode).emit("result", {
    correctAnswer: correctAnswer,
    answers: room.answers,
    scores: room.scores,
    users: room.users,
    question: currentQuestion.question,
    playerResults: playerResults, // Detailed results for each player
    summary: {
      correctPlayers: correctPlayers,
      incorrectPlayers: incorrectPlayers
    },
    time: 5
  });

  // Clear current question for next round
  room.currentQuestion = null;
  
  // Start next question after delay
  setTimeout(() => startQuestion(roomCode), 5000);
}

server.listen(PORT, () => {
  console.log("Server running on http://localhost:3000");
});