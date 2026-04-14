export type Role = 'user' | 'admin';

export interface CurrentUser {
  id: number;
  username: string;
  role: Role;
}

export interface RetrievedChunk {
  filename: string;
  page_number?: number | string | null;
  text?: string | null;
  score?: number | null;
  rrf_rank?: number | null;
  rerank_score?: number | null;
  chunk_id?: string;
  parent_chunk_id?: string;
  root_chunk_id?: string;
  chunk_level?: number;
  chunk_idx?: number;
}

export interface RagTrace {
  tool_used: boolean;
  tool_name: string;
  query?: string | null;
  expanded_query?: string | null;
  step_back_question?: string | null;
  step_back_answer?: string | null;
  expansion_type?: string | null;
  hypothetical_doc?: string | null;
  retrieval_stage?: string | null;
  grade_score?: string | null;
  grade_route?: string | null;
  rewrite_needed?: boolean | null;
  rewrite_strategy?: string | null;
  rewrite_query?: string | null;
  rerank_enabled?: boolean | null;
  rerank_applied?: boolean | null;
  rerank_model?: string | null;
  rerank_endpoint?: string | null;
  rerank_error?: string | null;
  retrieval_mode?: string | null;
  candidate_k?: number | null;
  leaf_retrieve_level?: number | null;
  auto_merge_enabled?: boolean | null;
  auto_merge_applied?: boolean | null;
  auto_merge_threshold?: number | null;
  auto_merge_replaced_chunks?: number | null;
  auto_merge_steps?: number | null;
  initial_retrieved_chunks?: RetrievedChunk[] | null;
  expanded_retrieved_chunks?: RetrievedChunk[] | null;
  retrieved_chunks?: RetrievedChunk[] | null;
  grade_error?: string | null;
}

export interface StoredMessage {
  type: 'human' | 'ai' | 'system';
  content: string;
  timestamp: string;
  rag_trace?: RagTrace | null;
}

export interface SessionInfo {
  session_id: string;
  updated_at: string;
  message_count: number;
}

export interface LoadedDocumentChunk {
  text: string;
  filename: string;
  file_type: string;
  file_path: string;
  page_number: number;
  chunk_id: string;
  parent_chunk_id: string;
  root_chunk_id: string;
  chunk_level: number;
  chunk_idx: number;
}

export interface RagStep {
  icon: string;
  label: string;
  detail: string;
}

export interface StreamEvent {
  type: 'content' | 'rag_step' | 'trace' | 'error';
  content?: string;
  step?: RagStep;
  rag_trace?: RagTrace | null;
}
