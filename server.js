const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};
const SUITS = ['h', 'd', 'c', 's'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUE = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, 'J':11, 'Q':12, 'K':13, 'A':14 };

// --- EVALUATOR ---
function evaluateHand(cards) {
    if (cards.length < 5) return { score: 0, name: "Waiting..." };
    const getCombinations = (arr, k) => {
        if (k > arr.length || k <= 0) return [];
        if (k === arr.length) return [arr];
        if (k === 1) return arr.map(e => [e]);
        let c = [];
        for (let i = 0; i < arr.length - k + 1; i++) {
            let h = arr.slice(i, i + 1);
            let t = getCombinations(arr.slice(i + 1), k - 1);
            for (let j = 0; j < t.length; j++) c.push(h.concat(t[j]));
        }
        return c;
    };
    const combos = getCombinations(cards, 5);
    let bestScore = -1;
    let bestName = "High Card";
    combos.forEach(hand => {
        const result = score5CardHand(hand);
        if (result.score > bestScore) {
            bestScore = result.score;
            bestName = result.name;
        }
    });
    return { score: bestScore, name: bestName };
}

function score5CardHand(hand) {
    hand.sort((a, b) => RANK_VALUE[b.rank] - RANK_VALUE[a.rank]);
    const v = hand.map(c => RANK_VALUE[c.rank]);
    const s = hand.map(c => c.suit);
    const isFlush = s.every(suit => suit === s[0]);
    let isStraight = true;
    for (let i = 0; i < 4; i++) if (v[i] - v[i + 1] !== 1) isStraight = false;
    if (!isStraight && v[0] === 14 && v[1] === 5 && v[2] === 4 && v[3] === 3 && v[4] === 2) isStraight = true;
    const counts = {}; v.forEach(x => counts[x] = (counts[x] || 0) + 1);
    const countValues = Object.values(counts).sort((a, b) => b - a);
    let rankScore = 0; let name = "High Card";
    let tieBreaker = 0;
    const addToTie = (vals) => vals.forEach((val, i) => tieBreaker += val * Math.pow(15, 4 - i));

    if (isStraight && isFlush) { rankScore = 8; name = "Straight Flush"; addToTie(v); }
    else if (countValues[0] === 4) { rankScore = 7; name = "Four of a Kind"; const q = parseInt(Object.keys(counts).find(k=>counts[k]===4)); const k = parseInt(Object.keys(counts).find(k=>counts[k]===1)); addToTie([q, k]); }
    else if (countValues[0] === 3 && countValues[1] === 2) { rankScore = 6; name = "Full House"; const t = parseInt(Object.keys(counts).find(k=>counts[k]===3)); const p = parseInt(Object.keys(counts).find(k=>counts[k]===2)); addToTie([t, p]); }
    else if (isFlush) { rankScore = 5; name = "Flush"; addToTie(v); }
    else if (isStraight) { rankScore = 4; name = "Straight"; addToTie(v); }
    else if (countValues[0] === 3) { rankScore = 3; name = "Three of a Kind"; const t = parseInt(Object.keys(counts).find(k=>counts[k]===3)); const k = v.filter(x=>x!==t); addToTie([t, ...k]); }
    else if (countValues[0] === 2 && countValues[1] === 2) { rankScore = 2; name = "Two Pair"; const p = Object.keys(counts).filter(k=>counts[k]===2).map(Number).sort((a,b)=>b-a); const k = v.find(x=>!p.includes(x)); addToTie([...p, k]); }
    else if (countValues[0] === 2) { rankScore = 1; name = "Pair"; const p = parseInt(Object.keys(counts).find(k=>counts[k]===2)); const k = v.filter(x=>x!==p); addToTie([p, ...k]); }
    else { rankScore = 0; name = "High Card"; addToTie(v); }
    return { score: (rankScore * 1000000) + tieBreaker, name };
}

function createDeck() {
    let deck = [];
    for (let s of SUITS) for (let r of RANKS) deck.push({ rank: r, suit: s });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    socket.on('createRoom', ({ name, startStack }) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        const chips = parseInt(startStack) || 1000;
        rooms[roomCode] = {
            roomCode, status: 'waiting', stage: 'preflop', pot: 0, currentBet: 0,
            communityCards: [], deck: [], turnIndex: 0, players: [], hostId: socket.id,
            startStack: chips, dealerIndex: 0
        };
        socket.join(roomCode);
        rooms[roomCode].players.push({ id: socket.id, name, chips, hand: [], bet: 0, status: 'active', hasActed: false });
        socket.emit('roomCreated', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', rooms[roomCode]);
    });

    socket.on('joinRoom', ({ name, roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        socket.join(roomCode);
        room.players.push({ id: socket.id, name, chips: room.startStack, hand: [], bet: 0, status: 'active', hasActed: false });
        socket.emit('joinedRoom', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', room);
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        startNewHand(room);
    });

    // --- BUY IN VOTING LOGIC ---
    socket.on('requestBuyIn', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if(!p || p.chips > 0) return; // Ignore if they have money

        // Broadcast vote request to everyone else
        socket.broadcast.to(roomCode).emit('startVote', { name: p.name, requesterId: socket.id });
        
        // Init vote state
        room.activeVote = {
            requesterId: socket.id,
            votes: {}, 
            required: room.players.length - 1 // All other players
        };
    });

    socket.on('castVote', ({ roomCode, vote }) => {
        const room = rooms[roomCode];
        if (!room || !room.activeVote) return;

        room.activeVote.votes[socket.id] = vote; // true/false

        const votesCast = Object.keys(room.activeVote.votes).length;
        if (votesCast >= room.activeVote.required) {
            // Tally
            const yesVotes = Object.values(room.activeVote.votes).filter(v => v === true).length;
            const success = yesVotes > (room.activeVote.required / 2); // Simple majority

            const target = room.players.find(p => p.id === room.activeVote.requesterId);
            
            if (success && target) {
                target.chips = room.startStack;
                target.status = 'folded'; // Wait for next hand
                io.to(roomCode).emit('notification', `${target.name} bought back in!`);
                io.to(roomCode).emit('gameState', room);
            } else {
                io.to(roomCode).emit('notification', `Buy-in denied for ${target?.name}.`);
            }
            delete room.activeVote;
            io.to(roomCode).emit('endVote'); // Hide modals
        }
    });

    socket.on('action', ({ roomCode, action, amount }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex !== room.turnIndex) return;
        const player = room.players[pIndex];
        const toCall = room.currentBet - player.bet;

        if (action === 'fold') { player.status = 'folded'; player.hasActed = true; }
        else if (action === 'check') { if (toCall > 0) return; player.hasActed = true; }
        else if (action === 'call') {
            const amt = Math.min(toCall, player.chips);
            player.chips -= amt; player.bet += amt; room.pot += amt; player.hasActed = true;
        } else if (action === 'raise') {
            const raiseAmt = parseInt(amount);
            const totalBet = room.currentBet + raiseAmt;
            const cost = totalBet - player.bet;
            if (player.chips >= cost) {
                player.chips -= cost; player.bet += cost; room.pot += cost; room.currentBet = totalBet; player.hasActed = true;
                room.players.forEach((p, i) => { if (i !== pIndex && p.status === 'active' && p.chips > 0) p.hasActed = false; });
            }
        }
        nextTurn(room);
    });
});

function startNewHand(room) {
    room.deck = createDeck(); room.status = 'playing'; room.stage = 'preflop'; room.pot = 0; room.currentBet = 0; room.communityCards = []; room.winnerMessage = null;
    room.players.forEach(p => {
        if (p.chips <= 0) p.status = 'busted';
        else { p.status = 'active'; p.hand = [room.deck.pop(), room.deck.pop()]; p.bet = 0; p.hasActed = false; }
    });
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    room.turnIndex = (room.dealerIndex + 1) % room.players.length;
    ensureActiveTurn(room);
    io.to(room.roomCode).emit('gameState', room);
}

function nextTurn(room) {
    const active = room.players.filter(p => p.status === 'active');
    const notFolded = room.players.filter(p => p.status !== 'folded' && p.status !== 'busted');
    if (notFolded.length === 1) { endHand(room, notFolded[0]); return; }
    const activeWithChips = active.filter(p => p.chips > 0);
    if (activeWithChips.every(p => p.hasActed && p.bet === room.currentBet)) { advanceStage(room); return; }
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    ensureActiveTurn(room);
    io.to(room.roomCode).emit('gameState', room);
}

function ensureActiveTurn(room) {
    let attempts = 0;
    while ((room.players[room.turnIndex].status !== 'active' || room.players[room.turnIndex].chips === 0) && attempts < room.players.length) {
        room.turnIndex = (room.turnIndex + 1) % room.players.length; attempts++;
    }
}

function advanceStage(room) {
    room.players.forEach(p => { p.bet = 0; p.hasActed = false; }); room.currentBet = 0;
    if (room.stage === 'preflop') { room.stage = 'flop'; room.communityCards.push(room.deck.pop(), room.deck.pop(), room.deck.pop()); }
    else if (room.stage === 'flop') { room.stage = 'turn'; room.communityCards.push(room.deck.pop()); }
    else if (room.stage === 'turn') { room.stage = 'river'; room.communityCards.push(room.deck.pop()); }
    else if (room.stage === 'river') { room.stage = 'showdown'; determineWinner(room); return; }
    room.turnIndex = (room.dealerIndex + 1) % room.players.length;
    ensureActiveTurn(room);
    io.to(room.roomCode).emit('gameState', room);
}

function determineWinner(room) {
    const active = room.players.filter(p => p.status !== 'folded' && p.status !== 'busted');
    let bestPlayer = null; let bestScore = -1; let bestHandName = "";
    active.forEach(p => {
        const result = evaluateHand([...p.hand, ...room.communityCards]);
        p.handStrength = result;
        if (result.score > bestScore) { bestScore = result.score; bestPlayer = p; bestHandName = result.name; }
    });
    endHand(room, bestPlayer, bestHandName);
}

function endHand(room, winner, handName) {
    winner.chips += room.pot; room.pot = 0;
    room.winnerMessage = handName ? `${winner.name} wins with ${handName}!` : `${winner.name} wins!`;
    room.status = 'finished';
    io.to(room.roomCode).emit('gameState', room);
    setTimeout(() => startNewHand(room), 8000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Poker Server on ${PORT}`));
