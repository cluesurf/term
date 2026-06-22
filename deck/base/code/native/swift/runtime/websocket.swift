// WebSocket client runtime over URLSessionWebSocketTask. The opaque handle a seed socket holds is the task itself, which
// buffers incoming messages, so receive pulls the next one with no message-loss race. receive returns the seed `message`
// form. Reached only through the public WebSocket API.
import Foundation

enum websocket {
    static func connect(_ url: String) async -> URLSessionWebSocketTask {
        let task = URLSession.shared.webSocketTask(with: URL(string: url)!)
        task.resume()
        return task
    }

    static func send(_ task: URLSessionWebSocketTask, _ data: String) async {
        try? await task.send(.string(data))
    }

    static func receive(_ task: URLSessionWebSocketTask) async -> Message {
        do {
            let message = try await task.receive()
            switch message {
            case .string(let text):
                return Message(kind: "text", data: text)
            case .data:
                return Message(kind: "text", data: "")
            @unknown default:
                return Message(kind: "close", data: "")
            }
        } catch {
            return Message(kind: "close", data: "")
        }
    }

    static func close(_ task: URLSessionWebSocketTask) async {
        task.cancel(with: .normalClosure, reason: nil)
    }
}
