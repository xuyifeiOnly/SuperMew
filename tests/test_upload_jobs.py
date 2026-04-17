import unittest

from backend.upload_jobs import UploadJobManager


class UploadJobManagerTests(unittest.TestCase):
    def test_tracks_step_percent_and_failure_state(self):
        manager = UploadJobManager()
        job = manager.create_job("sample.pdf")

        manager.update_step(job["job_id"], "upload", percent=73, status="running", message="正在上传")
        current = manager.get_job(job["job_id"])

        upload_step = next(step for step in current["steps"] if step["key"] == "upload")
        self.assertEqual(upload_step["percent"], 73)
        self.assertEqual(upload_step["status"], "running")
        self.assertEqual(current["status"], "running")
        self.assertEqual(current["current_step"], "upload")

        manager.complete_step(job["job_id"], "upload", message="文件已上传")
        manager.update_step(job["job_id"], "vector_store", percent=40, status="running", message="正在向量化入库：40 / 100")
        current = manager.get_job(job["job_id"])
        vector_step = next(step for step in current["steps"] if step["key"] == "vector_store")

        self.assertEqual(vector_step["percent"], 40)
        self.assertEqual(current["message"], "正在向量化入库：40 / 100")

        manager.fail_job(job["job_id"], "vector_store", "向量化失败")
        failed = manager.get_job(job["job_id"])

        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"], "向量化失败")
        self.assertEqual(failed["current_step"], "vector_store")


if __name__ == "__main__":
    unittest.main()
