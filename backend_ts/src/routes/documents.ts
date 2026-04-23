import fs from 'node:fs';
import path from 'node:path';
import multer from '@koa/multer';
import Router from '@koa/router';
import { createJobId, InMemoryJobManager, nowIso } from '../core/job-manager.js';
import { uploadDir } from '../config.js';
import { requireAdmin } from '../middleware/index.js';
import {
  deleteDocument,
  importDocumentsFromFolder,
  listDocuments,
  resetDocumentCollection,
  type UploadedDocumentFile,
  uploadDocument,
  uploadTextDocument,
} from '../services/document-service.js';
import type { AppState } from '../types/koa.js';

const upload = multer({
  storage: multer.memoryStorage(),
});

const router = new Router<AppState>();
const UPLOAD_JOB_TTL_MS = 10 * 60 * 1000;
const DELETE_JOB_TTL_MS = 10 * 60 * 1000;

interface UploadJobStep {
  key: 'upload' | 'cleanup' | 'parse' | 'parent_store' | 'vector_store';
  label: string;
  percent: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
}

interface UploadJob {
  job_id: string;
  filename: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  current_step: UploadJobStep['key'];
  message: string;
  total_chunks: number;
  processed_chunks: number;
  error: string | null;
  steps: UploadJobStep[];
  created_at: string;
  updated_at: string;
}

interface DeleteJobStep {
  key: 'prepare' | 'bm25' | 'milvus' | 'parent_store';
  label: string;
  percent: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  message: string;
}

interface DeleteJob {
  job_id: string;
  filename: string;
  status: 'running' | 'completed' | 'failed';
  message: string;
  steps: DeleteJobStep[];
  created_at: string;
  updated_at: string;
}

const uploadJobManager = new InMemoryJobManager<UploadJob>(UPLOAD_JOB_TTL_MS);
const deleteJobManager = new InMemoryJobManager<DeleteJob>(DELETE_JOB_TTL_MS);

const createUploadSteps = (): UploadJobStep[] => [
  { key: 'upload', label: '文档上传', percent: 0, status: 'pending', message: '' },
  { key: 'cleanup', label: '清理旧版本', percent: 0, status: 'pending', message: '' },
  { key: 'parse', label: '解析与分块', percent: 0, status: 'pending', message: '' },
  { key: 'parent_store', label: '父级分块入库', percent: 0, status: 'pending', message: '' },
  { key: 'vector_store', label: '向量化入库', percent: 0, status: 'pending', message: '' },
];

const updateUploadStep = (
  job: UploadJob,
  stepKey: UploadJobStep['key'],
  percent: number,
  status: UploadJobStep['status'],
  message: string,
  totalChunks?: number,
  processedChunks?: number,
) => {
  job.steps = job.steps.map((step) =>
    step.key === stepKey
      ? {
          ...step,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          status,
          message,
        }
      : step,
  );
  job.current_step = stepKey;
  job.status = status === 'failed' ? 'failed' : 'running';
  job.message = message;
  if (typeof totalChunks === 'number') {
    job.total_chunks = totalChunks;
  }
  if (typeof processedChunks === 'number') {
    job.processed_chunks = processedChunks;
  }
  job.updated_at = nowIso();
};

const completeUploadStep = (job: UploadJob, stepKey: UploadJobStep['key'], message: string) => {
  updateUploadStep(job, stepKey, 100, 'completed', message);
};

const failUploadJob = (job: UploadJob, stepKey: UploadJobStep['key'], errorMessage: string) => {
  updateUploadStep(job, stepKey, 100, 'failed', errorMessage);
  job.status = 'failed';
  job.message = errorMessage;
  job.error = errorMessage;
  job.updated_at = nowIso();
};

const runUploadJob = async (jobId: string, file: UploadedDocumentFile, allowedRolesInput?: unknown) => {
  const job = uploadJobManager.get(jobId);
  if (!job) {
    return;
  }

  try {
    completeUploadStep(job, 'upload', '文件已上传，等待后台处理');
    const result = await uploadDocument(file, allowedRolesInput, {
      onCleanupStart: () => {
        updateUploadStep(job, 'cleanup', 10, 'running', '正在清理同名旧文档');
      },
      onCleanupComplete: () => {
        completeUploadStep(job, 'cleanup', '旧版本清理完成');
      },
      onParseStart: () => {
        updateUploadStep(job, 'parse', 5, 'running', '正在解析文档并执行三级分块');
      },
      onParseComplete: (_filename, parentChunkCount, leafChunkCount) => {
        completeUploadStep(job, 'parse', `解析完成：父级分块 ${parentChunkCount} 个，叶子分块 ${leafChunkCount} 个`);
      },
      onParentStoreStart: (_filename, parentChunkCount) => {
        updateUploadStep(job, 'parent_store', 20, 'running', `正在写入父级分块（${parentChunkCount} 个）`);
      },
      onParentStoreComplete: (_filename, parentChunkCount) => {
        completeUploadStep(job, 'parent_store', `父级分块已入库：${parentChunkCount} 个`);
      },
      onVectorStoreStart: (_filename, leafChunkCount) => {
        updateUploadStep(
          job,
          'vector_store',
          0,
          'running',
          `正在向量化入库：0 / ${leafChunkCount}`,
          leafChunkCount,
          0,
        );
      },
      onVectorStoreProgress: (_filename, processed, total) => {
        const percent = total > 0 ? Math.round((processed * 100) / total) : 100;
        updateUploadStep(job, 'vector_store', percent, 'running', `正在向量化入库：${processed} / ${total}`, total, processed);
      },
      onVectorStoreComplete: (_filename, leafChunkCount) => {
        completeUploadStep(job, 'vector_store', `向量化入库完成：${leafChunkCount} 个叶子分块`);
      },
    });
    job.steps = job.steps.map((step) => ({
      ...step,
      percent: step.status === 'failed' ? step.percent : 100,
      status: step.status === 'failed' ? step.status : 'completed',
    }));
    job.status = 'completed';
    job.current_step = 'vector_store';
    job.message = result?.message || `成功上传并处理 ${job.filename}`;
    job.error = null;
    job.updated_at = nowIso();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep = job.steps.find((step) => step.status === 'running')?.key ?? job.current_step ?? 'cleanup';
    failUploadJob(job, failedStep, message);
  }
};

const runTextUploadJob = async (
  jobId: string,
  text: string,
  filename: string,
  allowedRolesInput?: unknown,
) => {
  const job = uploadJobManager.get(jobId);
  if (!job) {
    return;
  }

  try {
    completeUploadStep(job, 'upload', '文本已提交，等待后台处理');
    const result = await uploadTextDocument(text, filename, allowedRolesInput, {
      onCleanupStart: () => {
        updateUploadStep(job, 'cleanup', 10, 'running', '正在清理同名旧文档');
      },
      onCleanupComplete: () => {
        completeUploadStep(job, 'cleanup', '旧版本清理完成');
      },
      onParseStart: () => {
        updateUploadStep(job, 'parse', 5, 'running', '正在解析文本并执行三级分块');
      },
      onParseComplete: (_filename, parentChunkCount, leafChunkCount) => {
        completeUploadStep(job, 'parse', `解析完成：父级分块 ${parentChunkCount} 个，叶子分块 ${leafChunkCount} 个`);
      },
      onParentStoreStart: (_filename, parentChunkCount) => {
        updateUploadStep(job, 'parent_store', 20, 'running', `正在写入父级分块（${parentChunkCount} 个）`);
      },
      onParentStoreComplete: (_filename, parentChunkCount) => {
        completeUploadStep(job, 'parent_store', `父级分块已入库：${parentChunkCount} 个`);
      },
      onVectorStoreStart: (_filename, leafChunkCount) => {
        updateUploadStep(
          job,
          'vector_store',
          0,
          'running',
          `正在向量化入库：0 / ${leafChunkCount}`,
          leafChunkCount,
          0,
        );
      },
      onVectorStoreProgress: (_filename, processed, total) => {
        const percent = total > 0 ? Math.round((processed * 100) / total) : 100;
        updateUploadStep(job, 'vector_store', percent, 'running', `正在向量化入库：${processed} / ${total}`, total, processed);
      },
      onVectorStoreComplete: (_filename, leafChunkCount) => {
        completeUploadStep(job, 'vector_store', `向量化入库完成：${leafChunkCount} 个叶子分块`);
      },
    });
    job.steps = job.steps.map((step) => ({
      ...step,
      percent: step.status === 'failed' ? step.percent : 100,
      status: step.status === 'failed' ? step.status : 'completed',
    }));
    job.status = 'completed';
    job.current_step = 'vector_store';
    job.message = result?.message || `成功解析并处理 ${job.filename}`;
    job.error = null;
    job.updated_at = nowIso();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep = job.steps.find((step) => step.status === 'running')?.key ?? job.current_step ?? 'cleanup';
    failUploadJob(job, failedStep, message);
  }
};

const createDeleteSteps = (): DeleteJobStep[] => [
  { key: 'prepare', label: '准备删除', percent: 0, status: 'pending', message: '' },
  { key: 'bm25', label: '同步 BM25 统计', percent: 0, status: 'pending', message: '' },
  { key: 'milvus', label: '删除向量数据', percent: 0, status: 'pending', message: '' },
  { key: 'parent_store', label: '删除父级分块', percent: 0, status: 'pending', message: '' },
];

const updateDeleteStep = (
  job: DeleteJob,
  stepKey: DeleteJobStep['key'],
  percent: number,
  status: DeleteJobStep['status'],
  message: string,
) => {
  job.steps = job.steps.map((step) =>
    step.key === stepKey
      ? {
          ...step,
          percent: Math.max(0, Math.min(100, Math.round(percent))),
          status,
          message,
        }
      : step,
  );
  job.updated_at = nowIso();
};

const completePreviousDeleteSteps = (job: DeleteJob, stepKey: DeleteJobStep['key']) => {
  const order: DeleteJobStep['key'][] = ['prepare', 'bm25', 'milvus', 'parent_store'];
  const targetIndex = order.indexOf(stepKey);
  for (let i = 0; i < targetIndex; i += 1) {
    updateDeleteStep(job, order[i], 100, 'completed', '已完成');
  }
};

const runDeleteJob = async (jobId: string, filename: string) => {
  const job = deleteJobManager.get(jobId);
  if (!job) {
    return;
  }

  try {
    updateDeleteStep(job, 'prepare', 100, 'completed', '删除任务已提交');
    job.message = '开始删除文档';
    job.updated_at = nowIso();

    updateDeleteStep(job, 'bm25', 20, 'running', '正在同步 BM25 统计');
    updateDeleteStep(job, 'milvus', 55, 'running', '正在删除向量数据');
    updateDeleteStep(job, 'parent_store', 85, 'running', '正在删除父级分块');

    const result = await deleteDocument(filename);
    for (const step of ['bm25', 'milvus', 'parent_store'] as const) {
      updateDeleteStep(job, step, 100, 'completed', '已完成');
    }
    job.status = 'completed';
    job.message = result?.message || `成功删除文档 ${filename}`;
    job.updated_at = nowIso();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedStep =
      job.steps.find((step) => step.status === 'running')?.key ?? ('parent_store' as const);
    completePreviousDeleteSteps(job, failedStep);
    updateDeleteStep(job, failedStep, 100, 'failed', message);
    job.status = 'failed';
    job.message = `删除失败: ${message}`;
    job.updated_at = nowIso();
  }
};

router.get('/documents', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = { documents: await listDocuments() };
});

router.get('/documents/download/:filename', async (ctx) => {
  await requireAdmin(ctx);
  const filename = path.basename(String(ctx.params.filename ?? ''));
  if (!filename) {
    ctx.status = 400;
    ctx.body = { detail: '文件名不能为空' };
    return;
  }

  const resolvedUploadDir = path.resolve(uploadDir);
  const targetPath = path.resolve(resolvedUploadDir, filename);
  const relative = path.relative(resolvedUploadDir, targetPath);
  const isWithinUploadDir = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  if (!isWithinUploadDir) {
    ctx.status = 400;
    ctx.body = { detail: '非法文件路径' };
    return;
  }
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
    ctx.status = 404;
    ctx.body = { detail: '文件不存在' };
    return;
  }

  ctx.set('Cache-Control', 'no-store');
  ctx.attachment(filename);
  ctx.type = path.extname(filename);
  ctx.body = fs.createReadStream(targetPath);
});

router.post('/documents/upload/async', upload.single('file'), async (ctx) => {
  await requireAdmin(ctx);
  uploadJobManager.cleanupExpired();
  const file = (ctx.request as { file?: UploadedDocumentFile }).file;
  const body = (ctx.request as { body?: { allowed_roles?: unknown } }).body;
  const filename = path.basename(String(file?.originalname ?? ''));
  const jobId = createJobId();
  const createdAt = nowIso();
  if (!file) {
    ctx.status = 400;
    ctx.body = { detail: '缺少上传文件' };
    return;
  }
  if (!filename) {
    ctx.status = 400;
    ctx.body = { detail: '文件名不能为空' };
    return;
  }
  const job: UploadJob = {
    job_id: jobId,
    filename,
    status: 'pending',
    current_step: 'upload',
    message: '等待上传',
    total_chunks: 0,
    processed_chunks: 0,
    error: null,
    steps: createUploadSteps(),
    created_at: createdAt,
    updated_at: createdAt,
  };
  uploadJobManager.set(job);
  updateUploadStep(job, 'upload', 1, 'running', '正在保存文件到服务器');
  void runUploadJob(jobId, file, body?.allowed_roles);
  ctx.body = {
    job_id: jobId,
    filename,
    message: '文件已上传，正在后台解析和向量化入库',
  };
});

router.post('/documents/text/async', async (ctx) => {
  await requireAdmin(ctx);
  uploadJobManager.cleanupExpired();
  const body = (ctx.request as {
    body?: { content?: unknown; filename?: unknown; allowed_roles?: unknown };
  }).body;
  const text = String(body?.content ?? '').trim();
  const filename = path.basename(String(body?.filename ?? '')).trim() || `text_${Date.now()}.txt`;
  if (!text) {
    ctx.status = 400;
    ctx.body = { detail: '文本内容不能为空' };
    return;
  }

  const jobId = createJobId();
  const createdAt = nowIso();
  const job: UploadJob = {
    job_id: jobId,
    filename,
    status: 'pending',
    current_step: 'upload',
    message: '等待提交文本',
    total_chunks: 0,
    processed_chunks: 0,
    error: null,
    steps: createUploadSteps(),
    created_at: createdAt,
    updated_at: createdAt,
  };
  uploadJobManager.set(job);
  updateUploadStep(job, 'upload', 1, 'running', '正在提交文本内容');
  void runTextUploadJob(jobId, text, filename, body?.allowed_roles);
  ctx.body = {
    job_id: jobId,
    filename,
    message: '文本已提交，正在后台解析和向量化入库',
  };
});

router.get('/documents/upload/jobs/:jobId', async (ctx) => {
  await requireAdmin(ctx);
  uploadJobManager.cleanupExpired();
  const jobId = String(ctx.params.jobId ?? '');
  const job = uploadJobManager.get(jobId);
  if (!job) {
    ctx.status = 404;
    ctx.body = { detail: '上传任务不存在或已过期' };
    return;
  }
  ctx.body = job;
});

router.get('/documents/upload/jobs', async (ctx) => {
  await requireAdmin(ctx);
  uploadJobManager.cleanupExpired();
  const jobs = uploadJobManager.list().sort((a, b) => b.created_at.localeCompare(a.created_at));
  ctx.body = jobs;
});

router.post('/documents/upload', upload.single('file'), async (ctx) => {
  await requireAdmin(ctx);
  const file = (ctx.request as { file?: UploadedDocumentFile }).file;
  const body = (ctx.request as { body?: { allowed_roles?: unknown } }).body;
  ctx.body = await uploadDocument(file, body?.allowed_roles);
});

router.post('/documents/import-folder', async (ctx) => {
  await requireAdmin(ctx);
  const body = (ctx.request as { body?: { folderPath?: string; allowed_roles?: unknown } }).body;
  ctx.body = await importDocumentsFromFolder(String(body?.folderPath ?? ''), body?.allowed_roles);
});

router.delete('/documents/delete/async/:filename', async (ctx) => {
  await requireAdmin(ctx);
  deleteJobManager.cleanupExpired();
  const filename = path.basename(String(ctx.params.filename ?? ''));
  if (!filename) {
    ctx.status = 400;
    ctx.body = { detail: '文件名不能为空' };
    return;
  }
  const jobId = createJobId();
  const createdAt = nowIso();
  const job: DeleteJob = {
    job_id: jobId,
    filename,
    status: 'running',
    message: `正在删除 ${filename}`,
    steps: createDeleteSteps(),
    created_at: createdAt,
    updated_at: createdAt,
  };
  deleteJobManager.set(job);
  void runDeleteJob(jobId, filename);
  ctx.body = {
    job_id: jobId,
    filename,
    message: `正在删除 ${filename}`,
  };
});

router.get('/documents/delete/jobs/:jobId', async (ctx) => {
  await requireAdmin(ctx);
  deleteJobManager.cleanupExpired();
  const jobId = String(ctx.params.jobId ?? '');
  const job = deleteJobManager.get(jobId);
  if (!job) {
    ctx.status = 404;
    ctx.body = { detail: '删除任务不存在或已过期' };
    return;
  }
  ctx.body = job;
});

router.delete('/documents/:filename', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = await deleteDocument(String(ctx.params.filename ?? ''));
});

router.delete('/documents', async (ctx) => {
  await requireAdmin(ctx);
  ctx.body = await resetDocumentCollection();
});

export default router;
