const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static('public'));

const activeConnections = new Map();
const userPublicKeys = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('register-public-key', (data) => {
        const { publicKey } = data;
        userPublicKeys.set(socket.id, publicKey);
        console.log(`Public key registered for user: ${socket.id}`);
        socket.emit('key-registered', { success: true });
    });

    socket.on('request-transfer', (data) => {
        const { targetId, fileName } = data;
        const targetSocket = activeConnections.get(targetId);
        const senderPublicKey = userPublicKeys.get(socket.id);
        
        if (targetSocket && senderPublicKey) {
            targetSocket.emit('transfer-request', {
                sourceId: socket.id,
                fileName: fileName,
                senderPublicKey: senderPublicKey
            });
            console.log(`Transfer request sent from ${socket.id} to ${targetId}`);
        } else if (!targetSocket) {
            socket.emit('error', 'Target user not found');
        } else {
            socket.emit('error', 'Please register your public key first');
        }
    });

    socket.on('encrypted-data', (data) => {
        const { targetId, encryptedData, originalName, fileType, fileExtension } = data;
        const targetSocket = activeConnections.get(targetId);
        
        if (targetSocket) {
            targetSocket.emit('receive-data', {
                sourceId: socket.id,
                encryptedData: encryptedData,
                originalName: originalName,
                fileType: fileType,
                fileExtension: fileExtension
            });
            console.log(`Encrypted file data forwarded to ${targetId}:`, {
                originalName,
                fileType,
                fileExtension
            });
        } else {
            socket.emit('error', 'Target user not found');
        }
    });

    socket.on('accept-transfer', (data) => {
        const { sourceId } = data;
        const sourceSocket = activeConnections.get(sourceId);
        const recipientPublicKey = userPublicKeys.get(socket.id);
        
        if (sourceSocket && recipientPublicKey) {
            sourceSocket.emit('transfer-accepted', {
                targetId: socket.id,
                recipientPublicKey: recipientPublicKey
            });
        } else {
            socket.emit('error', 'Unable to accept transfer');
        }
    });

    socket.on('reject-transfer', (data) => {
        const { sourceId } = data;
        const sourceSocket = activeConnections.get(sourceId);
        
        if (sourceSocket) {
            sourceSocket.emit('transfer-rejected', {
                targetId: socket.id
            });
        }
    });

    activeConnections.set(socket.id, socket);

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        activeConnections.delete(socket.id);
        userPublicKeys.delete(socket.id);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});