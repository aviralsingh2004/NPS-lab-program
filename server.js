const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const CryptoJS = require('crypto-js');

// Serve static files
app.use(express.static('public'));

// Store active connections and their keys
const activeConnections = new Map();
const transferKeys = new Map();

// Generate a random encryption key
function generateKey() {
    return CryptoJS.lib.WordArray.random(32).toString();
}

// Encrypt data
function encryptData(data, key) {
    return CryptoJS.AES.encrypt(data, key).toString();
}

// Decrypt data
function decryptData(encryptedData, key) {
    const bytes = CryptoJS.AES.decrypt(encryptedData, key);
    return bytes.toString(CryptoJS.enc.Utf8);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Handle file transfer request
    socket.on('request-transfer', (data) => {
        const { targetId, fileName } = data;
        const targetSocket = activeConnections.get(targetId);
        
        if (targetSocket) {
            // Generate a unique key for this transfer
            const transferKey = generateKey();
            
            // Store the key with both socket IDs
            const transferId = `${socket.id}-${targetId}`;
            transferKeys.set(transferId, transferKey);
            
            // Send the key to the target
            targetSocket.emit('transfer-request', {
                sourceId: socket.id,
                fileName: fileName,
                key: transferKey,
                transferId: transferId
            });
            
            // Also send the key to the sender
            socket.emit('transfer-key', {
                targetId: targetId,
                key: transferKey,
                transferId: transferId
            });
            
            console.log(`Transfer key generated for ${transferId}`);
        } else {
            socket.emit('error', 'Target user not found');
        }
    });

    // Handle encrypted file data
    socket.on('encrypted-data', (data) => {
        const { targetId, encryptedData, transferId } = data;
        const targetSocket = activeConnections.get(targetId);
        
        if (targetSocket) {
            targetSocket.emit('receive-data', {
                sourceId: socket.id,
                encryptedData: encryptedData,
                transferId: transferId
            });
        }
    });

    // Handle transfer acceptance
    socket.on('accept-transfer', (data) => {
        const { sourceId, transferId } = data;
        const sourceSocket = activeConnections.get(sourceId);
        
        if (sourceSocket) {
            sourceSocket.emit('transfer-accepted', {
                targetId: socket.id,
                transferId: transferId
            });
        }
    });

    // Handle transfer rejection
    socket.on('reject-transfer', (data) => {
        const { sourceId, transferId } = data;
        const sourceSocket = activeConnections.get(sourceId);
        
        if (sourceSocket) {
            sourceSocket.emit('transfer-rejected', {
                targetId: socket.id,
                transferId: transferId
            });
            // Clean up the key
            transferKeys.delete(transferId);
        }
    });

    // Store the connection
    activeConnections.set(socket.id, socket);

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        activeConnections.delete(socket.id);
        // Clean up any transfer keys associated with this socket
        for (const [transferId, _] of transferKeys) {
            if (transferId.includes(socket.id)) {
                transferKeys.delete(transferId);
            }
        }
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 