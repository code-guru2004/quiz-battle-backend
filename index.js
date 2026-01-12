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

io.on("connection", (socket) => {
  console.log("Connected:", socket.id);

  socket.on("join-room", ({ roomCode, username }) => {
    socket.join(roomCode);

    if (!rooms[roomCode]) {
      rooms[roomCode] = {
        players: [],
        users: {},
        currentQuestionIndex: 0,
        answers: {},
        scores: {}
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
  room.answers = {};

  const q = questions[room.currentQuestionIndex];

  io.to(roomCode).emit("new-question", {
    question: q.question,
    options: q.options,
    time: 30
  });

  setTimeout(() => endQuestion(roomCode), 30000);
}

function endQuestion(roomCode) {
  const room = rooms[roomCode];
  const q = questions[room.currentQuestionIndex];

  for (let player of room.players) {
    if (room.answers[player] === q.answer) {
      room.scores[player] += 1;
    }
  }

  io.to(roomCode).emit("result", {
    correctAnswer: q.answer,
    answers: room.answers,
    scores: room.scores,
    users: room.users
  });

  room.currentQuestionIndex =
    (room.currentQuestionIndex + 1) % questions.length;

  setTimeout(() => startQuestion(roomCode), 5000);
}

server.listen(PORT, () => {
  console.log("Server running on http://localhost:3000");
});
