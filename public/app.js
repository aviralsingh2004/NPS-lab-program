// Connect to Socket.IO server
const socket = io();

// DOM Elements
const connectionStatus = document.getElementById("connectionStatus");
const userId = document.getElementById("userId");
const recipientId = document.getElementById("recipientId");
const fileInput = document.getElementById("fileInput");
const sendButton = document.getElementById("sendButton");
const transferStatus = document.getElementById("transferStatus");

// RSA Key pair storage
let keyPair = null;
let privateKey = null;
let publicKeyPem = null;

// Generate RSA key pair when connected
async function generateKeyPair() {
    try {
        keyPair = await window.crypto.subtle.generateKey(
            {
                name: "RSA-OAEP",
                modulusLength: 2048,
                publicExponent: new Uint8Array([1, 0, 1]),
                hash: "SHA-256",
            },
            true,
            ["encrypt", "decrypt"]
        );

        privateKey = keyPair.privateKey;
        
        // Export public key to PEM format
        const publicKeyBuffer = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
        publicKeyPem = arrayBufferToPem(publicKeyBuffer, "PUBLIC KEY");
        
        console.log("RSA key pair generated successfully");
        
        // Register public key with server
        socket.emit('register-public-key', { publicKey: publicKeyPem });
        
        return true;
    } catch (error) {
        console.error("Error generating key pair:", error);
        addTransferStatus("Error generating encryption keys");
        return false;
    }
}

// Convert ArrayBuffer to PEM format
function arrayBufferToPem(buffer, label) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const pem = `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
    return pem;
}

// Convert PEM to ArrayBuffer
function pemToArrayBuffer(pem) {
    const base64 = pem
        .replace(/-----BEGIN.*?-----/g, '')
        .replace(/-----END.*?-----/g, '')
        .replace(/\s/g, '');
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
}

// Import public key from PEM
async function importPublicKey(publicKeyPem) {
    try {
        const keyBuffer = pemToArrayBuffer(publicKeyPem);
        return await window.crypto.subtle.importKey(
            "spki",
            keyBuffer,
            {
                name: "RSA-OAEP",
                hash: "SHA-256",
            },
            false,
            ["encrypt"]
        );
    } catch (error) {
        console.error("Error importing public key:", error);
        throw error;
    }
}

// Encrypt data with RSA (for small data) or hybrid encryption (for large data)
async function encryptData(data, publicKeyPem) {
    try {
        const publicKey = await importPublicKey(publicKeyPem);
        
        // For large files, use hybrid encryption (AES + RSA)
        if (data.byteLength > 190) { // RSA-2048 can encrypt max ~190 bytes
            return await hybridEncrypt(data, publicKey);
        } else {
            // For small data, use direct RSA encryption
            const encryptedData = await window.crypto.subtle.encrypt(
                { name: "RSA-OAEP" },
                publicKey,
                data
            );
            return {
                type: 'rsa',
                data: arrayBufferToBase64(encryptedData)
            };
        }
    } catch (error) {
        console.error("Encryption error:", error);
        throw error;
    }
}

// Hybrid encryption: Generate AES key, encrypt data with AES, encrypt AES key with RSA
async function hybridEncrypt(data, publicKey) {
    try {
        // Generate AES key
        const aesKey = await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );

        // Generate random IV for AES
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        // Encrypt data with AES
        const encryptedData = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: iv },
            aesKey,
            data
        );

        // Export AES key to raw format
        const aesKeyBuffer = await window.crypto.subtle.exportKey("raw", aesKey);

        // Encrypt AES key with RSA
        const encryptedAesKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            publicKey,
            aesKeyBuffer
        );

        return {
            type: 'hybrid',
            encryptedData: arrayBufferToBase64(encryptedData),
            encryptedKey: arrayBufferToBase64(encryptedAesKey),
            iv: arrayBufferToBase64(iv)
        };
    } catch (error) {
        console.error("Hybrid encryption error:", error);
        throw error;
    }
}

// Decrypt data
async function decryptData(encryptedPayload) {
    try {
        if (encryptedPayload.type === 'rsa') {
            // Direct RSA decryption
            const encryptedData = base64ToArrayBuffer(encryptedPayload.data);
            const decryptedData = await window.crypto.subtle.decrypt(
                { name: "RSA-OAEP" },
                privateKey,
                encryptedData
            );
            return decryptedData;
        } else if (encryptedPayload.type === 'hybrid') {
            // Hybrid decryption
            return await hybridDecrypt(encryptedPayload);
        } else {
            throw new Error('Unknown encryption type');
        }
    } catch (error) {
        console.error("Decryption error:", error);
        throw error;
    }
}

// Hybrid decryption: Decrypt AES key with RSA, then decrypt data with AES
async function hybridDecrypt(encryptedPayload) {
    try {
        // Decrypt AES key with RSA
        const encryptedAesKey = base64ToArrayBuffer(encryptedPayload.encryptedKey);
        const aesKeyBuffer = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            privateKey,
            encryptedAesKey
        );

        // Import AES key
        const aesKey = await window.crypto.subtle.importKey(
            "raw",
            aesKeyBuffer,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
        );

        // Decrypt data with AES
        const iv = base64ToArrayBuffer(encryptedPayload.iv);
        const encryptedData = base64ToArrayBuffer(encryptedPayload.encryptedData);
        
        const decryptedData = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            aesKey,
            encryptedData
        );

        return decryptedData;
    } catch (error) {
        console.error("Hybrid decryption error:", error);
        throw error;
    }
}

// Helper function to convert ArrayBuffer to Base64
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
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
    return filename.slice(((filename.lastIndexOf(".") - 1) >>> 0) + 2);
}

// Helper function to get MIME type from extension
function getMimeType(filename) {
    const ext = getFileExtension(filename).toLowerCase();
    const mimeTypes = {
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        png: "image/png",
        gif: "image/gif",
        pdf: "application/pdf",
        doc: "application/msword",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        txt: "text/plain",
        zip: "application/zip",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        xls: "application/vnd.ms-excel",
        ppt: "application/vnd.ms-powerpoint",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        csv: "text/csv",
        json: "application/json",
        xml: "application/xml",
        html: "text/html",
        css: "text/css",
        js: "application/javascript",
        exe: "application/octet-stream",
        dll: "application/octet-stream",
        iso: "application/octet-stream",
    };
    return mimeTypes[ext] || "application/octet-stream";
}

// Update connection status and generate keys
socket.on("connect", async () => {
    connectionStatus.textContent = "Connected - Generating Keys...";
    connectionStatus.classList.add("text-yellow-600");
    userId.textContent = socket.id;
    
    // Generate RSA key pair
    const success = await generateKeyPair();
    if (success) {
        connectionStatus.textContent = "Connected & Secured";
        connectionStatus.classList.remove("text-yellow-600");
        connectionStatus.classList.add("text-green-600");
        addTransferStatus("RSA encryption keys generated successfully");
    }
});

socket.on("disconnect", () => {
    connectionStatus.textContent = "Disconnected";
    connectionStatus.classList.remove("text-green-600", "text-yellow-600");
});

// Handle key registration confirmation
socket.on("key-registered", (data) => {
    if (data.success) {
        console.log("Public key registered with server");
    }
});

// Handle file transfer request
socket.on("transfer-request", (data) => {
    const { sourceId, fileName, senderPublicKey } = data;

    // Show transfer request dialog
    if (confirm(`User ${sourceId} wants to send you file: ${fileName}. Accept?`)) {
        socket.emit("accept-transfer", { sourceId });
        addTransferStatus(`Accepting file transfer from ${sourceId}...`);
    } else {
        socket.emit("reject-transfer", { sourceId });
        addTransferStatus(`Rejected file transfer from ${sourceId}`);
    }
});

// Handle encrypted data
socket.on("receive-data", async (data) => {
    const { sourceId, encryptedData, originalName, fileType, fileExtension } = data;

    try {
        console.log("Received encrypted data, attempting to decrypt...");
        
        // Parse the encrypted payload
        const encryptedPayload = JSON.parse(encryptedData);
        
        // Decrypt the data
        const decryptedArrayBuffer = await decryptData(encryptedPayload);
        
        console.log("Data decrypted successfully");

        // Handle filename and extension
        let downloadFileName = originalName || `received_file.${fileExtension}`;
        console.log("Preparing to download file:", downloadFileName);

        // Determine the correct MIME type
        let mimeType = fileType || getMimeType(downloadFileName);
        console.log("Using MIME type:", mimeType);

        // Create and download the file
        const blob = new Blob([decryptedArrayBuffer], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadFileName;
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Show success notification
        showNotification("File Received!", `File "${downloadFileName}" has been downloaded.`, "success");
        addTransferStatus(`File "${downloadFileName}" received and decrypted successfully. Check your Downloads folder.`);

    } catch (error) {
        console.error("Error during file processing:", error);
        addTransferStatus(`Error decrypting file: ${error.message}`);
        showNotification("Error!", "Failed to process the received file", "error");
    }
});

// Handle transfer acceptance
socket.on("transfer-accepted", async (data) => {
    const { targetId, recipientPublicKey } = data;
    addTransferStatus(`Transfer accepted by ${targetId}. Encrypting and sending file...`);
    await sendFile(targetId, recipientPublicKey);
});

// Handle transfer rejection
socket.on("transfer-rejected", (data) => {
    const { targetId } = data;
    addTransferStatus(`Transfer rejected by ${targetId}`);
});

// Handle errors
socket.on("error", (message) => {
    addTransferStatus(`Error: ${message}`);
});

// Send file
async function sendFile(targetId, recipientPublicKey) {
    const file = fileInput.files[0];
    if (!file) {
        addTransferStatus("Please select a file first");
        return;
    }

    try {
        const reader = new FileReader();
        
        reader.onload = async (e) => {
            try {
                const fileData = e.target.result;
                
                console.log("Encrypting file with recipient's public key...");
                
                // Encrypt the file data
                const encryptedPayload = await encryptData(fileData, recipientPublicKey);
                
                // Get file metadata
                const fileMetadata = {
                    originalName: file.name,
                    fileType: file.type,
                    fileExtension: getFileExtension(file.name),
                };

                console.log("Sending encrypted file:", fileMetadata);

                // Send the encrypted data
                socket.emit("encrypted-data", {
                    targetId,
                    encryptedData: JSON.stringify(encryptedPayload),
                    ...fileMetadata,
                });

                addTransferStatus("File encrypted and sent successfully");
            } catch (error) {
                console.error("Error processing file:", error);
                addTransferStatus(`Error encrypting file: ${error.message}`);
            }
        };

        // Read file as ArrayBuffer
        reader.readAsArrayBuffer(file);
        
    } catch (error) {
        console.error("Error sending file:", error);
        addTransferStatus(`Error: ${error.message}`);
    }
}

// Show notification
function showNotification(title, message, type = "success") {
    const notification = document.createElement("div");
    const bgColor = type === "success" ? "#10B981" : "#EF4444";
    const icon = type === "success" 
        ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"></path>'
        : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>';

    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background-color: ${bgColor};
        color: white;
        padding: 1rem;
        border-radius: 0.5rem;
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
        z-index: 9999;
        animation: slideIn 0.5s ease-out;
        max-width: 300px;
    `;

    notification.innerHTML = `
        <div class="flex items-center space-x-2">
            <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                ${icon}
            </svg>
            <div>
                <p class="font-bold text-lg">${title}</p>
                <p>${message}</p>
                ${type === "success" ? '<p class="text-sm mt-1">Check your Downloads folder</p>' : ''}
            </div>
        </div>
    `;

    document.body.appendChild(notification);

    // Remove notification after 8 seconds
    setTimeout(() => {
        notification.style.animation = "slideOut 0.5s ease-out";
        setTimeout(() => notification.remove(), 500);
    }, 8000);
}

// Add status message
function addTransferStatus(message) {
    const statusElement = document.createElement("p");
    statusElement.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    statusElement.className = "text-sm text-gray-600";
    transferStatus.insertBefore(statusElement, transferStatus.firstChild);
}

// Handle send button click
sendButton.addEventListener("click", () => {
    const targetId = recipientId.value.trim();
    if (!targetId) {
        addTransferStatus("Please enter a recipient ID");
        return;
    }

    const file = fileInput.files[0];
    if (!file) {
        addTransferStatus("Please select a file");
        return;
    }

    if (!keyPair) {
        addTransferStatus("Encryption keys not ready. Please wait...");
        return;
    }

    // Request transfer
    socket.emit("request-transfer", {
        targetId,
        fileName: file.name,
    });

    addTransferStatus(`Requesting transfer to ${targetId}...`);
});