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

// --- POKER EVALUATOR ENGINE ---
function evaluateHand(cards) {
    if (cards.length < 5) return { score: 0, name: "Waiting..." };

    // Get all 5-card combinations
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
    // Sort desc
    hand.sort((a, b) => RANK_VALUE[b.rank] - RANK_VALUE[a.rank]);
    const v = hand.map(c => RANK_VALUE[c.rank]);
    const s = hand.map(c => c.suit);

    const isFlush = s.every(suit => suit === s[0]);
    
    let isStraight = true;
    for (let i = 0; i < 4; i++) {
        if (v[i] - v[i + 1] !== 1) isStraight = false;
    }
    // Wheel check (A, 5, 4, 3, 2)
    if (!isStraight && v[0] === 14 && v[1] === 5 && v[2] === 4 && v[3] === 3 && v[4] === 2) {
        isStraight = true;
    }

    const counts = {};
    v.forEach(x => counts[x] = (counts[x] || 0) + 1);
    const countValues = Object.values(counts).sort((a, b) => b - a);

    let rankScore = 0;
    let name = "High Card";
    
    // Tie-breaker: Calculate generic value based on card importance
    // Hex: 0x(Rank)(Kicker1)(Kicker2)...
    // We use base 15 for simplicity
    let tieBreaker = 0;
    
    // Helper to add values to tiebreaker in order of importance
    const addToTie = (vals) => {
        vals.forEach((val, i) => {
            tieBreaker += val * Math.pow(15, 4 - i);
        });
    };

    if (isStraight && isFlush) {
        rankScore = 8; name = "Straight Flush";
        // Highest card determines strength (handle 5-high straight)
        const high = (v[0] === 14 && v[4] === 2) ? 5 : v[0];
        tieBreaker = high;
    } else if (countValues[0] === 4) {
        rankScore = 7; name = "Four of a Kind";
        const quadVal = parseInt(Object.keys(counts).find(key => counts[key] === 4));
        const kicker = parseInt(Object.keys(counts).find(key => counts[key] === 1));
        addToTie([quadVal, kicker]);
    } else if (countValues[0] === 3 && countValues[1] === 2) {
        rankScore = 6; name = "Full House";
        const tripVal = parseInt(Object.keys(counts).find(key => counts[key] === 3));
        const pairVal = parseInt(Object.keys(counts).find(key => counts[key] === 2));
        addToTie([tripVal, pairVal]);
    } else if (isFlush) {
        rankScore = 5; name = "Flush";
        addToTie(v);
    } else if (isStraight) {
        rankScore = 4; name = "Straight";
        const high = (v[0] === 14 && v[4] === 2) ? 5 : v[0];
        tieBreaker = high;
    } else if (countValues[0] === 3) {
        rankScore = 3; name = "Three of a Kind";
        const tripVal = parseInt(Object.keys(counts).find(key => counts[key] === 3));
        const kickers = v.filter(x => x !== tripVal);
        addToTie([tripVal, ...kickers]);
    } else if (countValues[0] === 2 && countValues[1] === 2) {
        rankScore = 2; name = "Two Pair";
        const pairs = Object.keys(counts).filter(key => counts[key] === 2).map(Number).sort((a,b)=>b-a);
        const kicker = v.find(x => !pairs.includes(x));
        addToTie([...pairs, kicker]);
    } else if (countValues[0] === 2) {
        rankScore = 1; name = "Pair";
        const pairVal = parseInt(Object.keys(counts).find(key => counts[key] === 2));
        const kickers = v.filter(x => x !== pairVal);
        addToTie([pairVal, ...kickers]);
    } else {
        rankScore = 0; name = "High Card";
        addToTie(v);
    }

    return { score: (rankScore * 1000000) + tieBreaker, name };
}

// --- GAME LOGIC ---

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
    console.log('User:', socket.id);

    socket.on('createRoom', ({ name, startStack }) => {
        const roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        const chips = parseInt(startStack) || 1000;
        
        rooms[roomCode] = {
            roomCode,
            status: 'waiting',
            stage: 'preflop',
            pot: 0,
            currentBet: 0,
            communityCards: [],
            deck: [],
            turnIndex: 0,
            players: [],
            hostId: socket.id,
            startStack: chips,
            dealerIndex: 0,
            lastAggressorIndex: -1
        };
        socket.join(roomCode);
        
        rooms[roomCode].players.push({
            id: socket.id, name, chips, hand: [], bet: 0, 
            status: 'active', totalInvested: 0, hasActed: false 
        });

        socket.emit('roomCreated', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', rooms[roomCode]);
    });

    socket.on('joinRoom', ({ name, roomCode }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit('error', 'Room not found');
        
        socket.join(roomCode);
        room.players.push({
            id: socket.id, name, chips: room.startStack, hand: [], bet: 0, 
            status: 'active', totalInvested: 0, hasActed: false
        });

        socket.emit('joinedRoom', { roomCode, userId: socket.id });
        io.to(roomCode).emit('gameState', room);
    });

    socket.on('startGame', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;
        startNewHand(room);
    });

    socket.on('action', ({ roomCode, action, amount }) => {
        const room = rooms[roomCode];
        if (!room) return;

        const pIndex = room.players.findIndex(p => p.id === socket.id);
        if (pIndex !== room.turnIndex) return;

        const player = room.players[pIndex];
        const toCall = room.currentBet - player.bet;

        if (action === 'fold') {
            player.status = 'folded';
            player.hasActed = true;
        } else if (action === 'check') {
            if (toCall > 0) return; // Cannot check if there is a bet
            player.hasActed = true;
        } else if (action === 'call') {
            const betAmt = Math.min(toCall, player.chips);
            player.chips -= betAmt;
            player.bet += betAmt;
            room.pot += betAmt;
            player.hasActed = true;
        } else if (action === 'raise') {
            // "amount" is the amount ON TOP of the current bet
            // Total bet = currentBet + amount
            const raiseAmt = parseInt(amount);
            const totalBet = room.currentBet + raiseAmt;
            const cost = totalBet - player.bet;

            if (player.chips >= cost) {
                player.chips -= cost;
                player.bet += cost;
                room.pot += cost;
                room.currentBet = totalBet;
                player.hasActed = true;
                
                // Reset hasActed for everyone else because bet increased
                room.players.forEach((p, i) => {
                    if (i !== pIndex && p.status === 'active' && p.chips > 0) {
                        p.hasActed = false;
                    }
                });
            }
        }

        nextTurn(room);
    });
});

function startNewHand(room) {
    room.deck = createDeck();
    room.status = 'playing';
    room.stage = 'preflop';
    room.pot = 0;
    room.currentBet = 0;
    room.communityCards = [];
    room.winnerMessage = null;
    room.lastAggressorIndex = -1;

    // Reset Players
    room.players.forEach(p => {
        if (p.chips <= 0) p.status = 'busted';
        else {
            p.status = 'active';
            p.hand = [room.deck.pop(), room.deck.pop()];
            p.bet = 0;
            p.hasActed = false;
        }
    });

    // Move Dealer
    room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
    
    // Blinds (Simplified: Host is SB, Next BB)
    // Actually, to keep it simple and robust:
    // Dealer Button rotates. Left of dealer acts first Pre-flop?
    // Let's do Standard: SB, BB, UTG acts first.
    
    // For simplicity in this logic: No blinds for now, just ante or straight start.
    // Making it robust: Set turn to Dealer + 1
    room.turnIndex = (room.dealerIndex + 1) % room.players.length;
    // Skip busted players
    ensureActiveTurn(room);

    io.to(room.roomCode).emit('gameState', room);
}

function nextTurn(room) {
    // Check if round is over
    const active = room.players.filter(p => p.status === 'active');
    const notFolded = room.players.filter(p => p.status !== 'folded' && p.status !== 'busted');

    // 1. Everyone folded?
    if (notFolded.length === 1) {
        endHand(room, notFolded[0]);
        return;
    }

    // 2. Is Betting Round Complete?
    // Condition: All active players (who have chips) have acted AND matched the bet
    const activeWithChips = active.filter(p => p.chips > 0);
    const roundComplete = activeWithChips.every(p => p.hasActed && p.bet === room.currentBet);

    if (roundComplete) {
        advanceStage(room);
        return;
    }

    // 3. Move to next player
    room.turnIndex = (room.turnIndex + 1) % room.players.length;
    ensureActiveTurn(room);
    
    io.to(room.roomCode).emit('gameState', room);
}

function ensureActiveTurn(room) {
    let attempts = 0;
    while ((room.players[room.turnIndex].status !== 'active' || room.players[room.turnIndex].chips === 0) && attempts < room.players.length) {
        // If player is all-in (active but 0 chips), we skip them for betting
        // unless they haven't acted? No, if chips is 0 they can't act.
        room.turnIndex = (room.turnIndex + 1) % room.players.length;
        attempts++;
    }
}

function advanceStage(room) {
    // Reset bets
    room.players.forEach(p => { p.bet = 0; p.hasActed = false; });
    room.currentBet = 0;

    if (room.stage === 'preflop') {
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
        determineWinner(room);
        return;
    }

    // Reset turn to left of dealer
    room.turnIndex = (room.dealerIndex + 1) % room.players.length;
    ensureActiveTurn(room);
    
    io.to(room.roomCode).emit('gameState', room);
}

function determineWinner(room) {
    const active = room.players.filter(p => p.status !== 'folded' && p.status !== 'busted');
    
    let bestPlayer = null;
    let bestScore = -1;
    let bestHandName = "";

    active.forEach(p => {
        const fullHand = [...p.hand, ...room.communityCards];
        const result = evaluateHand(fullHand);
        p.handStrength = result; // Store for client display

        if (result.score > bestScore) {
            bestScore = result.score;
            bestPlayer = p;
            bestHandName = result.name;
        }
    });

    endHand(room, bestPlayer, bestHandName);
}

function endHand(room, winner, handName) {
    winner.chips += room.pot;
    room.pot = 0;
    
    const winMsg = handName ? `${winner.name} wins with ${handName}!` : `${winner.name} wins (Opponents folded)`;
    room.winnerMessage = winMsg;
    room.status = 'finished'; // This triggers card reveal on client

    io.to(room.roomCode).emit('gameState', room);

    setTimeout(() => {
        startNewHand(room);
    }, 8000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Poker Server on ${PORT}`));
