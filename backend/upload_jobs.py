"""上传任务进度管理。

轻量版先使用进程内存保存任务状态，适合当前单进程开发部署。
如果后续要支持多进程或服务重启恢复，可以把同样的数据结构迁移到 Redis/PostgreSQL。
"""
from __future__ import annotations

from copy import deepcopy
from datetime import UTC, datetime
from threading import Lock
from typing import Literal
from uuid import uuid4


StepStatus = Literal["pending", "running", "completed", "failed"]
JobStatus = Literal["pending", "running", "completed", "failed"]


DEFAULT_STEPS = [
    ("upload", "文档上传"),
    ("cleanup", "清理旧版本"),
    ("parse", "解析与分块"),
    ("parent_store", "父级分块入库"),
    ("vector_store", "向量化入库"),
]


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


class UploadJobManager:
    """线程安全的上传任务状态容器。"""

    def __init__(self):
        self._jobs: dict[str, dict] = {}
        self._lock = Lock()

    def create_job(self, filename: str) -> dict:
        job_id = uuid4().hex
        now = _now_iso()
        job = {
            "job_id": job_id,
            "filename": filename,
            "status": "pending",
            "current_step": "upload",
            "message": "等待上传",
            "total_chunks": 0,
            "processed_chunks": 0,
            "error": None,
            "created_at": now,
            "updated_at": now,
            "steps": [
                {
                    "key": key,
                    "label": label,
                    "percent": 0,
                    "status": "pending",
                    "message": "",
                }
                for key, label in DEFAULT_STEPS
            ],
        }
        with self._lock:
            self._jobs[job_id] = job
            return deepcopy(job)

    def get_job(self, job_id: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return deepcopy(job) if job else None

    def update_step(
        self,
        job_id: str,
        step_key: str,
        percent: int,
        status: StepStatus = "running",
        message: str = "",
        *,
        total_chunks: int | None = None,
        processed_chunks: int | None = None,
    ) -> dict | None:
        percent = max(0, min(100, int(percent)))
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None

            step = self._find_step(job, step_key)
            if not step:
                return None

            step["percent"] = percent
            step["status"] = status
            step["message"] = message
            job["status"] = "failed" if status == "failed" else "running"
            job["current_step"] = step_key
            job["message"] = message
            job["updated_at"] = _now_iso()

            if total_chunks is not None:
                job["total_chunks"] = int(total_chunks)
            if processed_chunks is not None:
                job["processed_chunks"] = int(processed_chunks)

            return deepcopy(job)

    def complete_step(self, job_id: str, step_key: str, message: str = "") -> dict | None:
        return self.update_step(job_id, step_key, 100, "completed", message)

    def complete_job(self, job_id: str, message: str = "文档入库完成") -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            for step in job["steps"]:
                if step["status"] != "failed":
                    step["percent"] = 100
                    step["status"] = "completed"
            job["status"] = "completed"
            job["current_step"] = "vector_store"
            job["message"] = message
            job["error"] = None
            job["updated_at"] = _now_iso()
            return deepcopy(job)

    def fail_job(self, job_id: str, step_key: str, error: str) -> dict | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            step = self._find_step(job, step_key)
            if step:
                step["status"] = "failed"
                step["message"] = error
            job["status"] = "failed"
            job["current_step"] = step_key
            job["message"] = error
            job["error"] = error
            job["updated_at"] = _now_iso()
            return deepcopy(job)

    def list_jobs(self) -> list[dict]:
        with self._lock:
            return [deepcopy(job) for job in self._jobs.values()]

    @staticmethod
    def _find_step(job: dict, step_key: str) -> dict | None:
        for step in job["steps"]:
            if step["key"] == step_key:
                return step
        return None


upload_job_manager = UploadJobManager()
