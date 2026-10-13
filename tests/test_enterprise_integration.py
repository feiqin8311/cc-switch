#!/usr/bin/env python3
"""
端到端集成验证脚本：
验证企业中心服务端与客户端契约 (Auth, RBAC Policies, Conversation Audit, Codex Skills Marketplace)
"""

import subprocess
import time
import urllib.request
import json
import os
import signal

SERVER_URL = "http://127.0.0.1:4000"

def run_integration_test():
    server_script = os.path.join(os.path.dirname(__file__), "..", "server", "server.py")
    proc = subprocess.Popen(["python3", server_script])
    time.sleep(1) # 等待服务启动

    try:
        # 1. 验证 Admin 登录
        login_req = urllib.request.Request(
            f"{SERVER_URL}/api/v1/auth/login",
            data=json.dumps({"username": "admin", "password": "admin123"}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(login_req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            assert data["user"]["role"] == "admin", f"Expected admin, got {data['user']['role']}"
            assert len(data["config"]["policies"]) == 3, "Admin should have 3 enterprise provider pools"
            admin_token = data["token"]
            print("✅ 1. Admin 登录与完整模型池分配验证通过")

        # 2. 验证 Developer 登录与 RBAC 策略受限
        dev_req = urllib.request.Request(
            f"{SERVER_URL}/api/v1/auth/login",
            data=json.dumps({"username": "developer", "password": "dev123"}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(dev_req) as resp:
            dev_data = json.loads(resp.read().decode("utf-8"))
            assert dev_data["user"]["role"] == "developer"
            assert len(dev_data["config"]["policies"]) == 2, "Developer has restricted provider pools"
            dev_token = dev_data["token"]
            print("✅ 2. Developer 研发角色 RBAC 隔离与配额下发验证通过")

        # 3. 验证对话审计与云端归档上报
        audit_payload = {
            "logs": [
                {
                    "sessionId": "sess-test-001",
                    "userId": "u-dev",
                    "providerId": "codex-enterprise-pool",
                    "model": "o3-mini",
                    "promptPreview": "实现一个二叉树前序遍历",
                    "messagesJson": '[{"role":"user","content":"实现一个二叉树前序遍历"}]',
                    "responseText": "def preorder(root): ...",
                    "promptTokens": 25,
                    "completionTokens": 80,
                    "timestamp": int(time.time())
                }
            ]
        }
        audit_req = urllib.request.Request(
            f"{SERVER_URL}/api/v1/audit/conversations",
            data=json.dumps(audit_payload).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {dev_token}"
            }
        )
        with urllib.request.urlopen(audit_req) as resp:
            audit_resp = json.loads(resp.read().decode("utf-8"))
            assert audit_resp["count"] == 1
            assert audit_resp["status"] == "success"
            print("✅ 3. 对话留存与审计上报接收验证通过")

        # 4. 验证管理员拉取审计日志归档
        audit_list_req = urllib.request.Request(
            f"{SERVER_URL}/api/v1/audit/logs",
            headers={"Authorization": f"Bearer {admin_token}"}
        )
        with urllib.request.urlopen(audit_list_req) as resp:
            logs = json.loads(resp.read().decode("utf-8"))["logs"]
            assert len(logs) >= 1
            assert logs[0]["sessionId"] == "sess-test-001"
            assert logs[0]["promptTokens"] == 25
            print("✅ 4. 管理端审计日志回溯与归档查询验证通过")

        # 5. 验证企业 Codex 技能市场
        market_req = urllib.request.Request(f"{SERVER_URL}/api/v1/marketplace/skills")
        with urllib.request.urlopen(market_req) as resp:
            skills = json.loads(resp.read().decode("utf-8"))
            assert len(skills) >= 1
            codex_skills = [s for s in skills if "codex" in s["supportedApps"]]
            assert len(codex_skills) >= 1
            print(f"✅ 5. 企业私有 Codex Skill 市场元数据分发验证通过 (包含: {codex_skills[0]['name']})")

        print("\n🎉 全部端到端集成测试用例通过 (5/5)!")
    finally:
        proc.terminate()
        proc.wait()

if __name__ == "__main__":
    run_integration_test()
