// Connect to Socket.IO server
const socket = io();

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const userId = document.getElementById('userId');
const recipientId = document.getElementById('recipientId');
const fileInput = document.getElementById('fileInput');
const sendButton = document.getElementById('sendButton');
const transferStatus = document.getElementById('transferStatus');

// Store transfer keys
const transferKeys = new Map();

// Update connection status
socket.on('connect', () => {
    connectionStatus.textContent = 'Connected';
    connectionStatus.classList.add('text-green-600');
    userId.textContent = socket.id;
});

socket.on('disconnect', () => {
    connectionStatus.textContent = 'Disconnected';
    connectionStatus.classList.remove('text-green-600');
});

// Handle file transfer request
socket.on('transfer-request', (data) => {
    const { sourceId, fileName, key, transferId } = data;
    
    // Store the key for this transfer
    transferKeys.set(transferId, key);
    
    // Show transfer request dialog
    if (confirm(`User ${sourceId} wants to send you file: ${fileName}. Accept?`)) {
        socket.emit('accept-transfer', { sourceId, transferId });
        addTransferStatus(`Accepting file transfer from ${sourceId}...`);
    } else {
        socket.emit('reject-transfer', { sourceId, transferId });
        addTransferStatus(`Rejected file transfer from ${sourceId}`);
    }
});

// Handle transfer key
socket.on('transfer-key', (data) => {
    const { targetId, key, transferId } = data;
    transferKeys.set(transferId, key);
    console.log('Received transfer key for:', transferId);
});

// Helper function to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// Helper function to convert Base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

// Helper function to get file extension
function getFileExtension(filename) {
    return filename.slice((filename.lastIndexOf(".") - 1 >>> 0) + 2);
}

// Helper function to get MIME type from extension
function getMimeType(filename) {
    const ext = getFileExtension(filename).toLowerCase();
    const mimeTypes = {
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'png': 'image/png',
        'gif': 'image/gif',
        'pdf': 'application/pdf',
        'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'txt': 'text/plain',
        'zip': 'application/zip',
        'mp3': 'audio/mpeg',
        'mp4': 'video/mp4'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// Handle encrypted data
socket.on('receive-data', (data) => {
    const { sourceId, encryptedData, transferId, fileName, fileType, fileExtension } = data;
    const key = transferKeys.get(transferId);
    
    if (key) {
        try {
            console.log('Received encrypted data, attempting to decrypt...');
            // Decrypt the data
            const decryptedBase64 = CryptoJS.AES.decrypt(encryptedData, key).toString(CryptoJS.enc.Utf8);
            
            // Convert Base64 back to ArrayBuffer
            const arrayBuffer = base64ToArrayBuffer(decryptedBase64);
            
            console.log('Data decrypted successfully');
            console.log('Preparing to download file:', fileName);
            
            // Ensure the file has the correct extension
            const downloadFileName = fileName.includes('.') ? fileName : `${fileName}.${fileExtension}`;
            
            // Create and download the file with proper MIME type
            const blob = new Blob([arrayBuffer], { 
                type: fileType || getMimeType(downloadFileName)
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = downloadFileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            // Show notification
            const notification = document.createElement('div');
            notification.className = 'fixed top-4 right-4 bg-green-500 text-white px-6 py-3 rounded-lg shadow-lg z-50 animate-bounce';
            notification.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                background-color: #10B981;
                color: white;
                padding: 1rem;
                border-radius: 0.5rem;
                box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
                z-index: 9999;
                animation: slideIn 0.5s ease-out;
            `;
            
            notification.innerHTML = `
                <div class="flex items-center space-x-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>
                    </svg>
                    <div>
                        <p class="font-bold text-lg">File Received!</p>
                        <p>File "${downloadFileName}" has been downloaded.</p>
                        <p class="text-sm mt-1">Check your Downloads folder</p>
                    </div>
                </div>
            `;
            
            document.body.appendChild(notification);
            console.log('Notification displayed');
            
            // Remove notification after 8 seconds
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.5s ease-out';
                setTimeout(() => notification.remove(), 500);
            }, 8000);
            
            addTransferStatus(`File "${downloadFileName}" received and decrypted successfully. Check your Downloads folder.`);
            
            // Clean up
            transferKeys.delete(transferId);
        } catch (error) {
            console.error('Error during file processing:', error);
            addTransferStatus(`Error decrypting file: ${error.message}`);
            
            // Show error notification
            const errorNotification = document.createElement('div');
            errorNotification.className = 'fixed top-4 right-4 bg-red-500 text-white px-6 py-3 rounded-lg shadow-lg z-50';
            errorNotification.innerHTML = `
                <div class="flex items-center space-x-2">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
                    </svg>
                    <div>
                        <p class="font-bold">Error!</p>
                        <p>Failed to process the received file</p>
                    </div>
                </div>
            `;
            document.body.appendChild(errorNotification);
            setTimeout(() => errorNotification.remove(), 5000);
        }
    } else {
        console.error('No key found for transferId:', transferId);
        addTransferStatus('Error: No encryption key found for this transfer');
    }
});

// Handle transfer acceptance
socket.on('transfer-accepted', (data) => {
    const { targetId, transferId } = data;
    addTransferStatus(`Transfer accepted by ${targetId}. Sending file...`);
    sendFile(targetId, transferId);
});

// Handle transfer rejection
socket.on('transfer-rejected', (data) => {
    const { targetId, transferId } = data;
    addTransferStatus(`Transfer rejected by ${targetId}`);
    transferKeys.delete(transferId);
});

// Handle errors
socket.on('error', (message) => {
    addTransferStatus(`Error: ${message}`);
});

// Send file
function sendFile(targetId, transferId) {
    const file = fileInput.files[0];
    if (!file) {
        addTransferStatus('Please select a file first');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const fileData = e.target.result;
        const key = transferKeys.get(transferId);
        
        if (key) {
            console.log('Encrypting file with key for transfer:', transferId);
            try {
                // Convert ArrayBuffer to Base64
                const base64Data = arrayBufferToBase64(fileData);
                
                // Encrypt the base64 data
                const encryptedData = CryptoJS.AES.encrypt(base64Data, key).toString();
                
                // Send the encrypted data with file metadata
                socket.emit('encrypted-data', {
                    targetId,
                    encryptedData,
                    transferId,
                    fileName: file.name,
                    fileType: file.type || getMimeType(file.name),
                    fileExtension: getFileExtension(file.name)
                });
                
                addTransferStatus('File encrypted and sent');
            } catch (error) {
                console.error('Error processing file:', error);
                addTransferStatus('Error: File is too large or corrupted');
            }
        } else {
            console.error('No key found for transfer:', transferId);
            addTransferStatus('Error: No encryption key found');
        }
    };
    
    // Read file as ArrayBuffer
    reader.readAsArrayBuffer(file);
}

// Add status message
function addTransferStatus(message) {
    const statusElement = document.createElement('p');
    statusElement.textContent = message;
    statusElement.className = 'text-sm text-gray-600';
    transferStatus.insertBefore(statusElement, transferStatus.firstChild);
}

// Handle send button click
sendButton.addEventListener('click', () => {
    const targetId = recipientId.value.trim();
    if (!targetId) {
        addTransferStatus('Please enter a recipient ID');
        return;
    }
    
    const file = fileInput.files[0];
    if (!file) {
        addTransferStatus('Please select a file');
        return;
    }
    
    // Request transfer
    socket.emit('request-transfer', {
        targetId,
        fileName: file.name
    });
    
    addTransferStatus(`Requesting transfer to ${targetId}...`);
}); 