const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // Allow connections from anywhere
});

// Serve static files (HTML) from the 'public' folder
// Folder structure should be:
// - server.js
// - public/
//   - index.html
app.use(express.static(path.join(__dirname, 'public')));

// --- Game State ---
const rooms = {};

// Deck Helpers
const SUITS = ['h', 'd', 'c', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    let deck = [];
    for (let s of SUITS) for (let r of RANKS) deck.push({ rank: r, suit: s, value: RANKS.indexOf(r) + 2 });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// --- Socket Logic ---
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', ({ name }) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        rooms[roomCode] = {
            status: 'waiting',
            stage: 'preflop',
            pot: 0,
            currentBet: 0,
            communityCards: [],
            deck: [],
            turnIndex: 0,
            players: [],
            hostId: socket.id
        };
        socket.join(roomCode);
        
        // Add Host Player
        const player = { id: socket.id, name, chips: 1000, hand: [], bet: 0, status: 'active', totalInvested: 0 };
        rooms[roomCode].players.push(player);

        socket.emit('roomCreated', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', rooms[roomCode]);
    });

    socket.on('joinRoom', ({ name, roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        if (room.status !== 'waiting') return socket.emit('error', 'Game in progress');

        socket.join(roomCode);
        const player = { id: socket.id, name, chips: 1000, hand: [], bet: 0, status: 'active', totalInvested: 0 };
        room.players.push(player);

        socket.emit('joinedRoom', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', room);
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        if (room.players.length < 2) return socket.emit('error', 'Need 2+ players');

        // Init Game
        room.deck = createDeck();
        room.status = 'playing';
        room.stage = 'preflop';
        room.pot = 0;
        room.currentBet = 0;
        room.communityCards = [];
        
        // Deal Cards
        room.players.forEach(p => {
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.status = 'active';
            p.bet = 0;
        });

        io.to(roomCode).emit('gameState', room);
    });

    socket.on('action', ({ roomCode, action, amount }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.turnIndex) return; // Not your turn

        const player = room.players[playerIndex];

        // Logic
        if (action === 'fold') {
            player.status = 'folded';
        } else if (action === 'call' || action === 'check') {
            const cost = room.currentBet - player.bet;
            if(cost > player.chips) { // All in
                room.pot += player.chips;
                player.bet += player.chips;
                player.chips = 0;
            } else {
                player.chips -= cost;
                player.bet += cost;
                room.pot += cost;
            }
        } else if (action === 'raise') {
            const totalBet = room.currentBet + amount;
            const cost = totalBet - player.bet;
            if(player.chips >= cost) {
                player.chips -= cost;
                player.bet += cost;
                room.pot += cost;
                room.currentBet = player.bet; // Raise the table bet
            }
        }

        // Move Turn
        let nextIndex = (room.turnIndex + 1) % room.players.length;
        let attempts = 0;
        while(room.players[nextIndex].status !== 'active' && attempts < room.players.length) {
            nextIndex = (nextIndex + 1) % room.players.length;
            attempts++;
        }
        room.turnIndex = nextIndex;

        // Check for stage advancement (Simplified: if everyone matched bets)
        // Note: Real poker logic for side-pots/all-in is complex, this is basic flow
        const activePlayers = room.players.filter(p => p.status === 'active');
        const allMatched = activePlayers.every(p => p.bet === room.currentBet || p.chips === 0);
        
        if(allMatched && activePlayers.length > 1) {
            advanceStage(room);
        } else if (activePlayers.length === 1) {
             // Everyone else folded
             endHand(room, activePlayers[0]);
        }

        io.to(roomCode).emit('gameState', room);
    });

    const advanceStage = (room) => {
        // Reset Bets
        room.players.forEach(p => p.bet = 0);
        room.currentBet = 0;

        if(room.stage === 'preflop') {
            room.stage = 'flop';
            room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
        } else if (room.stage === 'flop') {
            room.stage = 'turn';
            room.communityCards.push(room.deck.pop());
        } else if (room.stage === 'turn') {
            room.stage = 'river';
            room.communityCards.push(room.deck.pop());
        } else if (room.stage === 'river') {
            room.stage = 'showdown';
            // Evaluate Winner (Basic High Card/Random for demo server)
            // Ideally import the evaluator here
            const winner = room.players.find(p => p.status === 'active'); 
            endHand(room, winner);
            return;
        }
    };

    const endHand = (room, winner) => {
        winner.chips += room.pot;
        room.pot = 0;
        room.winnerMessage = `${winner.name} wins!`;
        room.status = 'finished'; // Client can see result then request next hand
        
        // Auto restart after 5s
        setTimeout(() => {
            room.status = 'playing';
            room.stage = 'preflop';
            room.deck = createDeck();
            room.communityCards = [];
            room.winnerMessage = null;
            room.players.forEach(p => {
                if(p.chips > 0) {
                    p.status = 'active';
                    p.hand = [room.deck.pop(), room.deck.pop()];
                    p.bet = 0;
                } else {
                    p.status = 'busted';
                }
            });
            io.to(room.hostId).emit('gameState', room); // Or broadcast
            io.to(room.hostId).emit('requestNextHand'); // Or handle on server
        }, 5000);
    };

    socket.on('disconnect', () => {
        console.log('User disconnected');
        // Handle cleanup
    });
});

// Use process.env.PORT for deployment (Heroku/Render) or 3000 for local
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
