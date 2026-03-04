import { useState, useEffect, useRef } from 'react';

interface StreamingChatOptions {
  apiUrl: string;
  onMessage: (content: string) => void;
  onError?: (error: Error) => void;
  onComplete?: () => void;
}

export function useStreamingChat() {
  const [isStreaming, setIsStreaming] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const startStreaming = async (
    messages: any[],
    options: StreamingChatOptions
  ) => {
    setIsStreaming(true);
    setError(null);
    setIsOffline(false);

    try {
      // 使用 fetch 发起 POST 请求
      const response = await fetch(`${options.apiUrl}/api/stream/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) {
        throw new Error('Response body is null');
      }

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          setIsStreaming(false);
          options.onComplete?.();
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);

            if (data === ': keepalive') {
              // Keepalive 心跳，忽略
              continue;
            }

            try {
              const parsed = JSON.parse(data);

              if (parsed.error) {
                throw new Error(parsed.error);
              }

              if (parsed.content) {
                options.onMessage(parsed.content);
              }

              if (parsed.done) {
                setIsStreaming(false);
                options.onComplete?.();
                break;
              }
            } catch (parseError) {
              console.error('Failed to parse SSE data:', parseError);
            }
          }
        }
      }
    } catch (err: any) {
      console.error('[SSE] Error:', err);
      setError(err);
      setIsOffline(true);
      options.onError?.(err);

      // 自动重连（3 秒后）
      reconnectTimeoutRef.current = setTimeout(() => {
        console.log('[SSE] Attempting to reconnect...');
        startStreaming(messages, options);
      }, 3000);
    } finally {
      setIsStreaming(false);
    }
  };

  const stopStreaming = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    setIsStreaming(false);
  };

  const retry = (messages: any[], options: StreamingChatOptions) => {
    setIsOffline(false);
    setError(null);
    startStreaming(messages, options);
  };

  useEffect(() => {
    return () => {
      stopStreaming();
    };
  }, []);

  return {
    isStreaming,
    isOffline,
    error,
    startStreaming,
    stopStreaming,
    retry,
  };
}
