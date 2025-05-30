// server.js - Main server file
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Game state management
const games = new Map();
const prompts = [
  "A sleeping bear on a cozy chair",
  "A robot dancing in the rain",
  "A cat wearing a superhero cape",
  "An elephant balancing on a ball",
  "A wizard cooking breakfast",
  "A penguin surfing on a wave",
  "A dragon reading a book",
  "A unicorn playing guitar"
];

class Game {
  constructor(gameId) {
    this.id = gameId;
    this.players = new Map();
    this.teams = new Map();
    this.phase = 'waiting'; // waiting, drawing, voting, guessing, results
    this.currentPrompts = new Map();
    this.drawings = new Map();
    this.votes = new Map();
    this.guesses = new Map();
    this.scores = new Map();
    this.roundTimer = null;
  }

  addPlayer(playerId, playerName, teamName) {
    this.players.set(playerId, {
      id: playerId,
      name: playerName,
      team: teamName,
      connected: true
    });

    if (!this.teams.has(teamName)) {
      this.teams.set(teamName, []);
    }
    this.teams.get(teamName).push(playerId);
    this.scores.set(playerId, 0);
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (player) {
      this.players.delete(playerId);
      const team = this.teams.get(player.team);
      if (team) {
        const index = team.indexOf(playerId);
        if (index > -1) team.splice(index, 1);
        if (team.length === 0) {
          this.teams.delete(player.team);
        }
      }
    }
  }

  startDrawingPhase() {
    this.phase = 'drawing';
    this.currentPrompts.clear();
    this.drawings.clear();

    // Assign random prompts to players
    this.players.forEach((player, playerId) => {
      const randomPrompt = prompts[Math.floor(Math.random() * prompts.length)];
      this.currentPrompts.set(playerId, randomPrompt);
    });

    // 5 minute timer for drawing phase
    this.roundTimer = setTimeout(() => {
      this.startVotingPhase();
    }, 5 * 60 * 1000);
  }

  startVotingPhase() {
    this.phase = 'voting';
    this.votes.clear();
    
    // 2 minute timer for voting phase
    this.roundTimer = setTimeout(() => {
      this.startGuessingPhase();
    }, 2 * 60 * 1000);
  }

  startGuessingPhase() {
    this.phase = 'guessing';
    this.guesses.clear();
    
    // 3 minute timer for guessing phase
    this.roundTimer = setTimeout(() => {
      this.calculateScores();
      this.showResults();
    }, 3 * 60 * 1000);
  }

  calculateScores() {
    // Award points for best drawings
    const voteCount = new Map();
    this.votes.forEach(votes => {
      votes.forEach(drawingId => {
        voteCount.set(drawingId, (voteCount.get(drawingId) || 0) + 1);
      });
    });

    // Find winners for each prompt
    const promptWinners = new Map();
    this.currentPrompts.forEach((prompt, playerId) => {
      const votes = voteCount.get(playerId) || 0;
      if (!promptWinners.has(prompt) || votes > promptWinners.get(prompt).votes) {
        promptWinners.set(prompt, { playerId, votes });
      }
    });

    // Award points
    promptWinners.forEach(winner => {
      this.scores.set(winner.playerId, this.scores.get(winner.playerId) + 10);
    });

    // Award points for correct guesses and successful fake prompts
    this.guesses.forEach((guesses, guessingPlayerId) => {
      guesses.forEach((guess, drawingPlayerId) => {
        const correctPrompt = this.currentPrompts.get(drawingPlayerId);
        if (guess === correctPrompt) {
          // Correct guess
          this.scores.set(guessingPlayerId, this.scores.get(guessingPlayerId) + 5);
        } else {
          // Check if this fake prompt fooled others
          let fooledCount = 0;
          this.guesses.forEach((otherGuesses, otherPlayerId) => {
            if (otherPlayerId !== guessingPlayerId && 
                otherGuesses.get(drawingPlayerId) === guess) {
              fooledCount++;
            }
          });
          this.scores.set(guessingPlayerId, this.scores.get(guessingPlayerId) + fooledCount * 3);
        }
      });
    });
  }

  showResults() {
    this.phase = 'results';
    // Reset for next round after 30 seconds
    setTimeout(() => {
      this.phase = 'waiting';
    }, 30000);
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create-game', (callback) => {
    const gameId = Math.random().toString(36).substr(2, 6).toUpperCase();
    const game = new Game(gameId);
    games.set(gameId, game);
    
    socket.join(gameId);
    callback({ success: true, gameId });
  });

  socket.on('join-game', ({ gameId, playerName, teamName }, callback) => {
    const game = games.get(gameId);
    if (!game) {
      callback({ success: false, error: 'Game not found' });
      return;
    }

    game.addPlayer(socket.id, playerName, teamName);
    socket.join(gameId);
    socket.gameId = gameId;

    // Broadcast updated player list
    io.to(gameId).emit('players-updated', {
      players: Array.from(game.players.values()),
      teams: Object.fromEntries(game.teams)
    });

    callback({ success: true });
  });

  socket.on('start-game', () => {
    const game = games.get(socket.gameId);
    if (!game || game.players.size < 2) return;

    game.startDrawingPhase();
    
    // Send prompts to players
    game.players.forEach((player, playerId) => {
      const playerSocket = io.sockets.sockets.get(playerId);
      if (playerSocket) {
        playerSocket.emit('drawing-phase-start', {
          prompt: game.currentPrompts.get(playerId),
          timeLimit: 5 * 60 * 1000
        });
      }
    });

    io.to(socket.gameId).emit('game-phase-changed', { phase: 'drawing' });
  });

  socket.on('submit-drawing', ({ drawingData }) => {
    const game = games.get(socket.gameId);
    if (!game || game.phase !== 'drawing') return;

    game.drawings.set(socket.id, drawingData);
    
    // Check if all players have submitted
    if (game.drawings.size === game.players.size) {
      clearTimeout(game.roundTimer);
      game.startVotingPhase();
      
      // Send drawings for voting
      const drawingsForVoting = Array.from(game.drawings.entries()).map(([playerId, drawing]) => ({
        playerId,
        drawing,
        prompt: game.currentPrompts.get(playerId)
      }));

      io.to(socket.gameId).emit('voting-phase-start', {
        drawings: drawingsForVoting,
        timeLimit: 2 * 60 * 1000
      });
    }
  });

  socket.on('submit-votes', ({ votes }) => {
    const game = games.get(socket.gameId);
    if (!game || game.phase !== 'voting') return;

    game.votes.set(socket.id, votes);
    
    // Check if all players have voted
    if (game.votes.size === game.players.size) {
      clearTimeout(game.roundTimer);
      game.startGuessingPhase();
      
      // Find winning drawings and send for guessing
      const voteCount = new Map();
      game.votes.forEach(playerVotes => {
        playerVotes.forEach(drawingId => {
          voteCount.set(drawingId, (voteCount.get(drawingId) || 0) + 1);
        });
      });

      const winningDrawings = [];
      const promptGroups = new Map();
      
      game.currentPrompts.forEach((prompt, playerId) => {
        if (!promptGroups.has(prompt)) {
          promptGroups.set(prompt, []);
        }
        promptGroups.get(prompt).push({ playerId, votes: voteCount.get(playerId) || 0 });
      });

      promptGroups.forEach((players, prompt) => {
        const winner = players.reduce((max, player) => 
          player.votes > max.votes ? player : max
        );
        winningDrawings.push({
          playerId: winner.playerId,
          drawing: game.drawings.get(winner.playerId),
          actualPrompt: prompt
        });
      });

      io.to(socket.gameId).emit('guessing-phase-start', {
        winningDrawings,
        timeLimit: 3 * 60 * 1000
      });
    }
  });

  socket.on('submit-guesses', ({ guesses }) => {
    const game = games.get(socket.gameId);
    if (!game || game.phase !== 'guessing') return;

    game.guesses.set(socket.id, new Map(Object.entries(guesses)));
    
    // Check if all players have guessed
    if (game.guesses.size === game.players.size) {
      clearTimeout(game.roundTimer);
      game.calculateScores();
      game.showResults();
      
      io.to(socket.gameId).emit('results-phase-start', {
        scores: Object.fromEntries(game.scores),
        players: Object.fromEntries(game.players)
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.gameId) {
      const game = games.get(socket.gameId);
      if (game) {
        game.removePlayer(socket.id);
        
        // Clean up empty games
        if (game.players.size === 0) {
          games.delete(socket.gameId);
        } else {
          io.to(socket.gameId).emit('players-updated', {
            players: Array.from(game.players.values()),
            teams: Object.fromEntries(game.teams)
          });
        }
      }
    }
  });
});

// Routes
app.get('/game/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'game.html'));
});

app.get('/host/:gameId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});