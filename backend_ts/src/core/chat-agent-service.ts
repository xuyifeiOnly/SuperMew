import { AsyncQueue } from "./async-queue.js";
import { ConversationStorage } from "./conversation-storage.js";
import { RagService } from "./rag-service.js";
import { getCurrentWeather } from "./weather.js";
import type { RagTrace, Role, StreamEvent } from "../types.js";
import { z } from "zod";
import { createAgent } from "langchain";
import { tool } from "langchain/tools";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import {
  EmitEvent,
  createChatModel,
  modelResponseToText,
  normalizeText,
  promptModelText,
} from "./shared.js";
import { env } from "../config.js";

export class ChatAgentService {
  constructor(
    private readonly storage: ConversationStorage,
    private readonly ragService: RagService,
  ) {}

  private systemPrompt(): string {
    return [
      "你是一只可爱的棠棠助手，热心帮助用户。",
      "当用户询问文档或知识相关问题时，使用 search_knowledge_base 工具。",
      "在同一轮对话中，不要重复调用同一个工具。",
      "每轮对话最多只允许调用一次知识检索工具。",
      "如果检索到的上下文信息不足或者没有返回任何内容，直接回答说你不知道、无法从知识库中获取相关信息。",
    ].join(" ");
  }

  private toAgentMessages(
    history: Array<{ type: "human" | "ai" | "system"; content: string }>,
  ): BaseMessage[] {
    return history.map((item) => {
      if (item.type === "human") {
        return new HumanMessage(item.content);
      }
      if (item.type === "ai") {
        return new AIMessage(item.content);
      }
      return new SystemMessage(item.content);
    });
  }

  private extractTextFromAgentResult(messages: unknown[]): string {
    const last = messages[messages.length - 1] as
      | { content?: unknown }
      | undefined;
    const content = last?.content;
    if (typeof content === "string") {
      return normalizeText(content);
    }
    if (Array.isArray(content)) {
      const text = content
        .map((item: any) => {
          if (typeof item === "string") {
            return item;
          }
          if (item?.type === "text") {
            return normalizeText(item?.text);
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
      return modelResponseToText(text);
    }
    return "";
  }

  private async summarizeOldMessages(
    history: Array<{ type: "human" | "ai" | "system"; content: string }>,
  ): Promise<string> {
    if (!env.fastModel) {
      return "";
    }
    const conversation = history
      .map(
        (item) =>
          `${item.type === "human" ? "用户" : item.type === "ai" ? "AI" : "系统"}: ${item.content}`,
      )
      .join("\n");
    const summary = await promptModelText(
      `请总结以下对话的关键信息，包含用户信息、重要事实和待办事项：\n\n${conversation}`,
      env.fastModel,
      0.2,
    );
    return normalizeText(summary);
  }

  private async streamText(content: string, emit?: EmitEvent): Promise<void> {
    if (!emit || !content) {
      return;
    }
    const pieces: string[] = [];
    for (let index = 0; index < content.length; index += 24) {
      pieces.push(content.slice(index, index + 24));
    }
    for (const piece of pieces) {
      await emit({ type: "content", content: piece });
    }
  }

  private createAgentTools(
    emit: EmitEvent | undefined,
    ragTraceRef: { value: RagTrace | null },
    userRoles: Role[],
  ): Array<ReturnType<typeof tool>> {
    let knowledgeCalls = 0;
    const weatherTool = tool(
      async ({ location, extensions }) =>
        await getCurrentWeather(
          normalizeText(location),
          normalizeText(extensions || "base"),
        ),
      {
        name: "get_current_weather",
        description: "获取指定城市的天气信息",
        schema: z.object({
          location: z.string(),
          extensions: z.enum(["base", "all"]).optional(),
        }),
      },
    );
    const knowledgeTool = tool(
      async ({ query }) => {
        knowledgeCalls += 1;
        if (knowledgeCalls > 1) {
          return "本轮已执行过知识库检索，请基于已检索内容回答。";
        }
        const ragResult = await this.ragService.searchKnowledgeBase(
          normalizeText(query),
          userRoles,
          async (step) => {
            await emit?.({ type: "rag_step", step });
          },
        );
        ragTraceRef.value = ragResult.ragTrace;
        return ragResult.text;
      },
      {
        name: "search_knowledge_base",
        description: "搜索知识库中的相关信息",
        schema: z.object({
          query: z.string(),
        }),
      },
    );
    return [weatherTool, knowledgeTool];
  }

  private async invokeAgent(
    messages: BaseMessage[],
    userRoles: Role[],
    emit?: EmitEvent,
  ): Promise<{ response: string; ragTrace: RagTrace | null }> {
    const llm = createChatModel(env.model, 0.1);
    if (!llm) {
      const fallback = "模型未配置，无法生成回答。";
      await this.streamText(fallback, emit);
      return { response: fallback, ragTrace: null };
    }

    const ragTraceRef: { value: RagTrace | null } = { value: null };
    const agent = createAgent({
      model: llm,
      tools: this.createAgentTools(emit, ragTraceRef, userRoles),
      systemPrompt: this.systemPrompt(),
    });

    const result = await agent.invoke({ messages } as any);
    let finalResponse = this.extractTextFromAgentResult(
      (result as any).messages ?? [],
    );
    if (!finalResponse) {
      finalResponse = "未生成有效回答。";
    }
    if (emit) {
      await this.streamText(finalResponse, emit);
    }
    return { response: finalResponse, ragTrace: ragTraceRef.value };
  }

  private async runConversation(
    userText: string,
    userId: string,
    sessionId: string,
    userRoles: Role[],
    emit?: EmitEvent,
  ): Promise<{ response: string; ragTrace: RagTrace | null }> {
    const history = await this.storage.load(userId, sessionId);
    let messages = history;
    if (messages.length > 50) {
      const summary = await this.summarizeOldMessages(messages.slice(0, 40));
      if (summary) {
        messages = [
          { type: "system", content: `之前的对话摘要：\n${summary}` },
          ...messages.slice(40),
        ];
      }
    }

    messages = [...messages, { type: "human", content: userText }];
    const baseMessages = this.toAgentMessages(messages);
    
    const agentResult = await this.invokeAgent(baseMessages, userRoles, emit);
    const finalResponse = agentResult.response;
    const ragTrace = agentResult.ragTrace;

    const storedMessages = [
      ...messages,
      { type: "ai" as const, content: finalResponse },
    ];
    const extra = new Array(storedMessages.length).fill(null);
    extra[extra.length - 1] = { rag_trace: ragTrace };
    await this.storage.save(userId, sessionId, storedMessages, extra);
    if (emit && ragTrace) {
      await emit({ type: "trace", rag_trace: ragTrace });
    }
    return { response: finalResponse, ragTrace };
  }

  async chat(
    userText: string,
    userId: string,
    sessionId: string,
    userRoles: Role[],
  ): Promise<{ response: string; rag_trace: RagTrace | null }> {
    const result = await this.runConversation(userText, userId, sessionId, userRoles);
    return {
      response: result.response,
      rag_trace: result.ragTrace,
    };
  }

  chatStream(
    userText: string,
    userId: string,
    sessionId: string,
    userRoles: Role[],
  ): AsyncIterable<StreamEvent> {
    const queue = new AsyncQueue<StreamEvent>();
    void this.runConversation(userText, userId, sessionId, userRoles, async (event) => {
      queue.push(event);
    })
      .catch((error) => {
        queue.push({
          type: "error",
          content: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        queue.end();
      });
    return queue;
  }
}
