import { WebSocketServer } from 'ws'
import { EventEmitter } from 'events'
import crypto from 'crypto'

export class ChatServer extends EventEmitter {
  
    constructor(port = 8080) {
        super()
        this.wss = new WebSocketServer({ port })
        this.connections = new Map() // userId -> { ws, userData }
        this.rooms = new Map() // roomId -> Set of userIds
        this.userRooms = new Map() // userId -> Set of roomIds
        this.messageQueue = new Map() // userId -> Array of pending messages
        this.authTokens = new Map() // token -> userId (simple auth simulation)
        
        this.setupWebSocketHandlers()
        console.log(`Chat server running on port ${port}`)
    }

   
    setupWebSocketHandlers() {
    this.wss.on('connection', (ws, request) => {
        ws.isAlive = true
        ws.on('pong', () => { ws.isAlive = true })
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString())
                this.handleMessage(ws, message)
            } catch (error) {
                console.error('JSON parsing error:', error.message)
                this.sendError(ws, 'INVALID_JSON', 'Message must be valid JSON')
            }
        })
            ws.on('close', () => {
                this.handleDisconnection(ws)
            })

            ws.on('error', (error) => {
                console.error('WebSocket error:', error)
                this.handleDisconnection(ws)
            })
        })

        // Heartbeat to detect broken connections
        setInterval(() => {
            this.wss.clients.forEach((ws) => {
                if (!ws.isAlive) {
                    this.handleDisconnection(ws)
                    return ws.terminate()
                }
                ws.isAlive = false
                ws.ping()
            })
        }, 30000)
    }

 
    handleMessage(ws, message) {
        const { type, token, ...payload } = message

        if (type !== 'auth' && !this.isAuthenticated(ws)) {
            return this.sendError(ws, 'UNAUTHORIZED', 'Authentication required')
        }

        switch (type) {
            case 'auth':
                this.handleAuthentication(ws, token)
                break
            case 'join_room':
                this.handleJoinRoom(ws, payload.roomId)
                break
            case 'leave_room':
                this.handleLeaveRoom(ws, payload.roomId)
                break
            case 'send_message':
                this.handleSendMessage(ws, payload)
                break
            case 'create_room':
                this.handleCreateRoom(ws, payload.roomName, payload.isPrivate)
                break
            default:
                this.sendError(ws, 'INVALID_TYPE', 'Unknown message type')
        }
    }

  
    handleAuthentication(ws, token) {
        if (!token) {
            return this.sendError(ws, 'MISSING_TOKEN', 'Authentication token required')
        }

        const userId = this.validateToken(token)
        if (!userId) {
            return this.sendError(ws, 'INVALID_TOKEN', 'Invalid authentication token')
        }

        // Handle existing connection
        if (this.connections.has(userId)) {
            const existingConnection = this.connections.get(userId)
            existingConnection.ws.close(1000, 'New connection established')
        }

        ws.userId = userId
        this.connections.set(userId, {
            ws,
            userData: { userId, authenticatedAt: Date.now() }
        })
        this.userRooms.set(userId, new Set())

        this.sendMessage(ws, {
            type: 'auth_success',
            userId,
            timestamp: Date.now()
        })

        // Deliver queued messages
        this.deliverQueuedMessages(userId)
    }

 
    handleJoinRoom(ws, roomId) {
        if (!roomId) {
            return this.sendError(ws, 'MISSING_ROOM_ID', 'Room ID required')
        }

        const userId = ws.userId
        
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, new Set())
        }

        const room = this.rooms.get(roomId)
        room.add(userId)
        this.userRooms.get(userId).add(roomId)

        // Notify room members
        this.broadcastToRoom(roomId, {
            type: 'user_joined',
            userId,
            roomId,
            timestamp: Date.now()
        }, userId)

        this.sendMessage(ws, {
            type: 'room_joined',
            roomId,
            memberCount: room.size,
            timestamp: Date.now()
        })
    }

  
   handleLeaveRoom(ws, roomId) {
    if (!roomId) {
        return this.sendError(ws, 'MISSING_ROOM_ID', 'Room ID required')
    }
    
    const userId = ws.userId
    const room = this.rooms.get(roomId)
    
    if (!room?.has(userId)) {
        return this.sendError(ws, 'NOT_IN_ROOM', 'User not in specified room')
    }
        room.delete(userId)
        this.userRooms.get(userId).delete(roomId)

        // Clean up empty rooms
        if (room.size === 0) {
            this.rooms.delete(roomId)
        } else {
            this.broadcastToRoom(roomId, {
                type: 'user_left',
                userId,
                roomId,
                timestamp: Date.now()
            })
        }

        this.sendMessage(ws, {
            type: 'room_left',
            roomId,
            timestamp: Date.now()
        })
    }

    handleSendMessage(ws, { roomId, recipientId, content, messageId }) {
        if (!content?.trim()) {
            return this.sendError(ws, 'EMPTY_MESSAGE', 'Message content cannot be empty')
        }

        if (!messageId) {
            return this.sendError(ws, 'MISSING_MESSAGE_ID', 'Message ID required for tracking')
        }

        const senderId = ws.userId
        const timestamp = Date.now()
        const message = {
            type: 'message_received',
            messageId,
            senderId,
            content: content.trim(),
            timestamp,
            roomId,
            recipientId
        }

        let delivered = false

       // Group message
if (roomId) {
    const room = this.rooms.get(roomId)
    if (!room?.has(senderId)) {
        return this.sendError(ws, 'NOT_IN_ROOM', 'Must join room before sending messages')
    }
    
    this.broadcastToRoom(roomId, message, senderId)
    delivered = true
}
        // Private message
        else if (recipientId) {
            const recipient = this.connections.get(recipientId)
            if (recipient) {
                this.sendMessage(recipient.ws, message)
                delivered = true
            } else {
                // Queue message for offline user
                this.queueMessage(recipientId, message)
                delivered = true
            }
        }
        else {
            return this.sendError(ws, 'INVALID_TARGET', 'Must specify either roomId or recipientId')
        }

        // Send delivery confirmation
        if (delivered) {
            this.sendMessage(ws, {
                type: 'message_sent',
                messageId,
                timestamp: Date.now()
            })
        }
    }


    handleCreateRoom(ws, roomName, isPrivate = false) {
        if (!roomName?.trim()) {
            return this.sendError(ws, 'MISSING_ROOM_NAME', 'Room name required')
        }

        const roomId = this.generateRoomId()
        const userId = ws.userId

        this.rooms.set(roomId, new Set([userId]))
        this.userRooms.get(userId).add(roomId)

        this.sendMessage(ws, {
            type: 'room_created',
            roomId,
            roomName: roomName.trim(),
            isPrivate,
            createdBy: userId,
            timestamp: Date.now()
        })
    }

   
    handleDisconnection(ws) {
        const userId = ws.userId
        if (!userId) return

        // Remove from all rooms and notify
        const userRooms = this.userRooms.get(userId) || new Set()
        userRooms.forEach(roomId => {
            const room = this.rooms.get(roomId)
            if (room) {
                room.delete(userId)
                if (room.size === 0) {
                    this.rooms.delete(roomId)
                } else {
                    this.broadcastToRoom(roomId, {
                        type: 'user_disconnected',
                        userId,
                        roomId,
                        timestamp: Date.now()
                    })
                }
            }
        })

        // Cleanup user data
        this.connections.delete(userId)
        this.userRooms.delete(userId)
    }

  
    broadcastToRoom(roomId, message, excludeUserId = null) {
        const room = this.rooms.get(roomId)
        if (!room) return

        room.forEach(userId => {
            if (userId === excludeUserId) return
            
            const connection = this.connections.get(userId)
            if (connection) {
                this.sendMessage(connection.ws, message)
            } else {
                this.queueMessage(userId, message)
            }
        })
    }

  
    queueMessage(userId, message) {
        if (!this.messageQueue.has(userId)) {
            this.messageQueue.set(userId, [])
        }
        
        const queue = this.messageQueue.get(userId)
        queue.push(message)
        
        // Limit queue size to prevent memory issues
        if (queue.length > 100) {
            queue.shift()
        }
    }

  
    deliverQueuedMessages(userId) {
        const queue = this.messageQueue.get(userId)
        if (!queue || queue.length === 0) return

        const connection = this.connections.get(userId)
        if (!connection) return

        queue.forEach(message => {
            this.sendMessage(connection.ws, message)
        })

        this.messageQueue.delete(userId)
    }

   
    sendMessage(ws, message) {
        if (ws.readyState === ws.OPEN) {
            try {
                ws.send(JSON.stringify(message))
            } catch (error) {
                console.error('Failed to send message:', error)
            }
        }
    }

   
    sendError(ws, code, message) {
        this.sendMessage(ws, {
            type: 'error',
            error: { code, message },
            timestamp: Date.now()
        })
    }

  
    isAuthenticated(ws) {
        return ws.userId && this.connections.has(ws.userId)
    }

  
    validateToken(token) {
        return this.authTokens.get(token) || null
    }

  
    generateRoomId() {
        return crypto.randomBytes(16).toString('hex')
    }

   
    addAuthToken(token, userId) {
        this.authTokens.set(token, userId)
    }

    
    getStats() {
        return {
            connectedUsers: this.connections.size,
            activeRooms: this.rooms.size,
            queuedMessages: Array.from(this.messageQueue.values()).reduce((sum, queue) => sum + queue.length, 0)
        }
    }
}

// Usage example
const server = new ChatServer(8080)

// Add sample auth tokens for testing
server.addAuthToken('user1-token', 'user1')
server.addAuthToken('user2-token', 'user2')
server.addAuthToken('user3-token', 'user3')

export default ChatServer
