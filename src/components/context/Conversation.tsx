import { Check, Copy } from "lucide-react";
import type { Ref } from "react";
import type { ConversationMessage } from "../../domain";
export function Conversation({
  answerRef,
  running,
  messages,
  agentName,
  streamPreview,
  result,
  copiedMessageId,
  onCopy,
}: {
  answerRef: Ref<HTMLDivElement>;
  running: boolean;
  messages: ConversationMessage[];
  agentName: string;
  streamPreview: boolean;
  result: string;
  copiedMessageId: string | null;
  onCopy: (message: ConversationMessage) => Promise<void>;
}) {
  return (
    <div
      ref={answerRef}
      className={`context-answer context-conversation${running ? " is-streaming" : ""}`}
      role="log"
      aria-live="polite"
    >
      {messages.map((message) => (
        <article
          key={message.id}
          className={`context-chat-message ${message.role}`}
        >
          <header>
            <span>
              {message.id === "selected-text"
                ? "Selected text"
                : message.role === "user"
                  ? "You"
                  : agentName}
            </span>
            <button
              type="button"
              className="context-message-copy"
              onClick={() => void onCopy(message)}
              aria-label={
                message.id === "selected-text"
                  ? "Copy selected text"
                  : message.role === "user"
                    ? "Copy your message"
                    : `Copy ${agentName} response`
              }
              title={
                copiedMessageId === message.id ? "Copied" : "Copy to clipboard"
              }
            >
              {copiedMessageId === message.id ? (
                <Check size={11} />
              ) : (
                <Copy size={11} />
              )}
            </button>
          </header>
          <p>{message.text}</p>
        </article>
      ))}
      {running && (
        <article className="context-chat-message assistant is-streaming">
          <span>{agentName}</span>
          {result && streamPreview ? (
            <p>{result}</p>
          ) : (
            <div className="context-stream-placeholder">
              <i />
              <span>Your agent is preparing the response…</span>
            </div>
          )}
        </article>
      )}
    </div>
  );
}
