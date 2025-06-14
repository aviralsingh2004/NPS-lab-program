const socket = io();

const connectionStatus = document.getElementById("connectionStatus");
const userId = document.getElementById("userId");
const recipientId = document.getElementById("recipientId");
const fileInput = document.getElementById("fileInput");
const sendButton = document.getElementById("sendButton");
const transferStatus = document.getElementById("transferStatus");

let keyPair = null;
let privateKey = null;
let publicKeyPem = null;

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
        const publicKeyBuffer = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
        publicKeyPem = arrayBufferToPem(publicKeyBuffer, "PUBLIC KEY");
        
        console.log("RSA key pair generated successfully");
        socket.emit('register-public-key', { publicKey: publicKeyPem });
        
        return true;
    } catch (error) {
        console.error("Error generating key pair:", error);
        addTransferStatus("Error generating encryption keys");
        return false;
    }
}

function arrayBufferToPem(buffer, label) {
    const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----`;
}

function pemToArrayBuffer(pem) {
    const base64 = pem
        .replace(/-----BEGIN.*?-----/g, '')
        .replace(/-----END.*?-----/g, '')
        .replace(/\s/g, '');
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
}

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

async function deriveKeyFromPassphrase(passphrase, salt) {
    const encoder = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        "raw",
        encoder.encode(passphrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return await window.crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt: salt,
            iterations: 100000,
            hash: "SHA-256"
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        true,
        ["encrypt", "decrypt"]
    );
}

async function encryptWithPassphrase(data, passphrase) {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const aesKey = await deriveKeyFromPassphrase(passphrase, salt);
    const encryptedData = await window.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        data
    );
    return {
        encryptedData,
        salt,
        iv
    };
}

async function decryptWithPassphrase(encryptedData, passphrase, salt, iv) {
    const aesKey = await deriveKeyFromPassphrase(passphrase, salt);
    return await window.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv },
        aesKey,
        encryptedData
    );
}

async function encryptData(data, publicKeyPem, passphrase) {
    try {
        const publicKey = await importPublicKey(publicKeyPem);
        const { encryptedData: passphraseEncryptedData, salt, iv } = await encryptWithPassphrase(data, passphrase);
        
        if (passphraseEncryptedData.byteLength > 190) {
            return await hybridEncrypt(passphraseEncryptedData, publicKey, salt, iv);
        } else {
            const encryptedData = await window.crypto.subtle.encrypt(
                { name: "RSA-OAEP" },
                publicKey,
                passphraseEncryptedData
            );
            return {
                type: 'rsa',
                data: arrayBufferToBase64(encryptedData),
                salt: arrayBufferToBase64(salt),
                iv: arrayBufferToBase64(iv)
            };
        }
    } catch (error) {
        console.error("Encryption error:", error);
        throw error;
    }
}

async function hybridEncrypt(data, publicKey, salt, iv) {
    try {
        const aesKey = await window.crypto.subtle.generateKey(
            { name: "AES-GCM", length: 256 },
            true,
            ["encrypt", "decrypt"]
        );
        const hybridIv = window.crypto.getRandomValues(new Uint8Array(12));
        const encryptedData = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: hybridIv },
            aesKey,
            data
        );
        const aesKeyBuffer = await window.crypto.subtle.exportKey("raw", aesKey);
        const encryptedAesKey = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" },
            publicKey,
            aesKeyBuffer
        );
        return {
            type: 'hybrid',
            encryptedData: arrayBufferToBase64(encryptedData),
            encryptedKey: arrayBufferToBase64(encryptedAesKey),
            iv: arrayBufferToBase64(hybridIv),
            salt: arrayBufferToBase64(salt),
            passphraseIv: arrayBufferToBase64(iv)
        };
    } catch (error) {
        console.error("Hybrid encryption error:", error);
        throw error;
    }
}

async function decryptData(encryptedPayload) {
    try {
        const passphrase = prompt("Enter the passphrase to decrypt the file:");
        if (!passphrase) {
            throw new Error("Passphrase is required for decryption");
        }
        if (encryptedPayload.type === 'rsa') {
            const encryptedData = base64ToArrayBuffer(encryptedPayload.data);
            const salt = base64ToArrayBuffer(encryptedPayload.salt);
            const iv = base64ToArrayBuffer(encryptedPayload.iv);
            const decryptedData = await window.crypto.subtle.decrypt(
                { name: "RSA-OAEP" },
                privateKey,
                encryptedData
            );
            return await decryptWithPassphrase(decryptedData, passphrase, salt, iv);
        } else if (encryptedPayload.type === 'hybrid') {
            return await hybridDecrypt(encryptedPayload, passphrase);
        } else {
            throw new Error('Unknown encryption type');
        }
    } catch (error) {
        console.error("Decryption error:", error);
        throw error;
    }
}

async function hybridDecrypt(encryptedPayload, passphrase) {
    try {
        const encryptedAesKey = base64ToArrayBuffer(encryptedPayload.encryptedKey);
        const aesKeyBuffer = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            privateKey,
            encryptedAesKey
        );
        const aesKey = await window.crypto.subtle.importKey(
            "raw",
            aesKeyBuffer,
            { name: "AES-GCM", length: 256 },
            false,
            ["decrypt"]
        );
        const iv = base64ToArrayBuffer(encryptedPayload.iv);
        const encryptedData = base64ToArrayBuffer(encryptedPayload.encryptedData);
        const salt = base64ToArrayBuffer(encryptedPayload.salt);
        const passphraseIv = base64ToArrayBuffer(encryptedPayload.passphraseIv);
        const decryptedData = await window.crypto.subtle.decrypt(
            { name: "AES-GCM", iv: iv },
            aesKey,
            encryptedData
        );
        return await decryptWithPassphrase(decryptedData, passphrase, salt, passphraseIv);
    } catch (error) {
        console.error("Hybrid decryption error:", error);
        throw error;
    }
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
}

function getFileExtension(filename) {
    return filename.slice(((filename.lastIndexOf(".") - 1) >>> 0) + 2);
}

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

socket.on("connect", async () => {
    connectionStatus.textContent = "Connected - Generating Keys...";
    connectionStatus.classList.add("text-yellow-600");
    userId.textContent = socket.id;
    
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

socket.on("key-registered", (data) => {
    if (data.success) {
        console.log("Public key registered with server");
    }
});

socket.on("transfer-request", (data) => {
    const { sourceId, fileName, senderPublicKey } = data;
    if (confirm(`User ${sourceId} wants to send you file: ${fileName}. Accept?`)) {
        socket.emit("accept-transfer", { sourceId });
        addTransferStatus(`Accepting file transfer from ${sourceId}...`);
    } else {
        socket.emit("reject-transfer", { sourceId });
        addTransferStatus(`Rejected file transfer from ${sourceId}`);
    }
});

socket.on("receive-data", async (data) => {
    const { sourceId, encryptedData, originalName, fileType, fileExtension } = data;
    try {
        console.log("Received encrypted data, attempting to decrypt...");
        const encryptedPayload = JSON.parse(encryptedData);
        const decryptedArrayBuffer = await decryptData(encryptedPayload);
        console.log("Data decrypted successfully");
        let downloadFileName = originalName || `received_file.${fileExtension}`;
        console.log("Preparing to download file:", downloadFileName);
        let mimeType = fileType || getMimeType(downloadFileName);
        console.log("Using MIME type:", mimeType);
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
        showNotification("File Received!", `File "${downloadFileName}" has been downloaded.`, "success");
        addTransferStatus(`File "${downloadFileName}" received and decrypted successfully. Check your Downloads folder.`);
    } catch (error) {
        console.error("Error during file processing:", error);
        addTransferStatus(`Error decrypting file: ${error.message}`);
        showNotification("Error!", "Failed to process the received file", "error");
    }
});

socket.on("transfer-accepted", async (data) => {
    const { targetId, recipientPublicKey } = data;
    addTransferStatus(`Transfer accepted by ${targetId}. Encrypting and sending file...`);
    await sendFile(targetId, recipientPublicKey);
});

socket.on("transfer-rejected", (data) => {
    const { targetId } = data;
    addTransferStatus(`Transfer rejected by ${targetId}`);
});

socket.on("error", (message) => {
    addTransferStatus(`Error: ${message}`);
});

async function sendFile(targetId, recipientPublicKey) {
    const file = fileInput.files[0];
    if (!file) {
        addTransferStatus("Please select a file first");
        return;
    }
    const passphrase = prompt("Enter a passphrase to encrypt the file:");
    if (!passphrase) {
        addTransferStatus("Passphrase is required for encryption");
        return;
    }
    try {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const fileData = e.target.result;
                console.log("Encrypting file with recipient's public key and passphrase...");
                const encryptedPayload = await encryptData(fileData, recipientPublicKey, passphrase);
                const fileMetadata = {
                    originalName: file.name,
                    fileType: file.type,
                    fileExtension: getFileExtension(file.name),
                };
                console.log("Sending encrypted file:", fileMetadata);
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
        reader.readAsArrayBuffer(file);
    } catch (error) {
        console.error("Error sending file:", error);
        addTransferStatus(`Error: ${error.message}`);
    }
}

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
    setTimeout(() => {
        notification.style.animation = "slideOut 0.5s ease-out";
        setTimeout(() => notification.remove(), 500);
    }, 8000);
}

function addTransferStatus(message) {
    const statusElement = document.createElement("p");
    statusElement.textContent = `${new Date().toLocaleTimeString()}: ${message}`;
    statusElement.className = "text-sm text-gray-600";
    transferStatus.insertBefore(statusElement, transferStatus.firstChild);
}

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
    socket.emit("request-transfer", {
        targetId,
        fileName: file.name,
    });
    addTransferStatus(`Requesting transfer to ${targetId}...`);
});