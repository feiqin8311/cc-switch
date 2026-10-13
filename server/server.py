#!/usr/bin/env python3
"""
轻量企业中心管理服务端参考实现 (Reference Enterprise Cloud Backend)
无外部依赖，基于 Python 标准库 http.server，支持：
1. 多用户与 RBAC 角色登录 (/api/v1/auth/login)
2. 集中模型池与角色配额策略下发 (/api/v1/client/config)
3. 客户端对话审计与用量归档日志接收 (/api/v1/audit/conversations)
4. 企业私有 Codex Skill 市场元数据与分发 (/api/v1/marketplace/skills)
"""

import json
import sqlite3
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse
import os

PORT = 4000
DB_FILE = os.path.join(os.path.dirname(__file__), "enterprise_center.db")

# 初始化 SQLite 数据库
def init_db():
    conn = sqlite3.connect(DB_FILE)
    c = conn.cursor()
    # 用户表
    c.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT,
            role TEXT,
            tenant_id TEXT
        )
    ''')
    # 对话审计表
    c.execute('''
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT,
            user_id TEXT,
            provider_id TEXT,
            model TEXT,
            prompt_preview TEXT,
            messages_json TEXT,
            response_text TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            timestamp INTEGER
        )
    ''')
    # 预设种子用户
    c.execute("INSERT OR IGNORE INTO users VALUES ('u-admin', 'admin', 'admin123', 'admin', 'tenant-default')")
    c.execute("INSERT OR IGNORE INTO users VALUES ('u-dev', 'developer', 'dev123', 'developer', 'tenant-default')")
    c.execute("INSERT OR IGNORE INTO users VALUES ('u-guest', 'guest', 'guest123', 'viewer', 'tenant-default')")
    conn.commit()
    conn.close()

# 预设模型与配额策略
POLICIES_BY_ROLE = {
    'admin': [
        {
            'providerId': 'claude-official-team',
            'providerType': 'claude',
            'providerName': 'Claude 官方企业订阅 (Admin)',
            'allowedModels': ['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'],
            'dailyQuotaTokens': 10000000,
            'usedTokensToday': 12050,
            'isManaged': True,
        },
        {
            'providerId': 'codex-enterprise-pool',
            'providerType': 'codex',
            'providerName': 'OpenAI Codex 专有实例 (Admin)',
            'allowedModels': ['o3-mini', 'o1', 'gpt-4o'],
            'dailyQuotaTokens': 10000000,
            'usedTokensToday': 5200,
            'isManaged': True,
        },
        {
            'providerId': 'deepseek-v3-internal',
            'providerType': 'deepseek',
            'providerName': 'DeepSeek 内网私有化部署',
            'allowedModels': ['deepseek-chat', 'deepseek-reasoner'],
            'dailyQuotaTokens': 20000000,
            'usedTokensToday': 34000,
            'isManaged': True,
        }
    ],
    'developer': [
        {
            'providerId': 'claude-official-team',
            'providerType': 'claude',
            'providerName': 'Claude 官方订阅 (研发专用)',
            'allowedModels': ['claude-3-7-sonnet', 'claude-3-5-haiku'],
            'dailyQuotaTokens': 500000,
            'usedTokensToday': 18500,
            'isManaged': True,
        },
        {
            'providerId': 'codex-enterprise-pool',
            'providerType': 'codex',
            'providerName': 'OpenAI Codex (研发专用)',
            'allowedModels': ['o3-mini', 'gpt-4o'],
            'dailyQuotaTokens': 500000,
            'usedTokensToday': 9200,
            'isManaged': True,
        }
    ],
    'viewer': [
        {
            'providerId': 'deepseek-v3-internal',
            'providerType': 'deepseek',
            'providerName': 'DeepSeek 体验模型',
            'allowedModels': ['deepseek-chat'],
            'dailyQuotaTokens': 50000,
            'usedTokensToday': 1200,
            'isManaged': True,
        }
    ]
}

ENTERPRISE_SKILLS = [
    {
        'id': 'corp-code-reviewer',
        'name': 'Corporate Code Reviewer',
        'description': '企业统一代码规范合规检查与架构审计 Skill',
        'version': '1.2.0',
        'author': 'Enterprise Tech Commitee',
        'downloadUrl': 'https://internal-repo.example.com/skills/corp-reviewer.zip',
        'isMandatory': True,
        'supportedApps': ['codex', 'claude'],
    },
    {
        'id': 'corp-db-assistant',
        'name': 'DB Schema Helper',
        'description': '一键校验 SQL 变更并生成迁移脚本',
        'version': '1.0.4',
        'author': 'DBA Team',
        'downloadUrl': 'https://internal-repo.example.com/skills/db-helper.zip',
        'isMandatory': False,
        'supportedApps': ['codex'],
    }
]

class EnterpriseHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        content_len = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_len).decode('utf-8') if content_len > 0 else '{}'
        data = json.loads(body) if body else {}

        if url.path == '/api/v1/auth/login':
            username = data.get('username') or ''
            password = data.get('password') or ''
            auth_code = data.get('authCode') or ''

            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            user = None
            if auth_code:
                # 授权码登录模式
                user = ('u-dev', 'developer', '', 'developer', 'tenant-default')
            else:
                c.execute("SELECT id, username, password, role, tenant_id FROM users WHERE username = ?", (username,))
                row = c.fetchone()
                if row and row[2] == password:
                    user = row
            conn.close()

            if not user:
                return self._send_json(401, {'message': '用户名或密码错误'})

            user_profile = {
                'id': user[0],
                'username': user[1],
                'email': f'{user[1]}@enterprise.internal',
                'role': user[3],
                'tenantId': user[4],
            }
            role = user[3]
            policies = POLICIES_BY_ROLE.get(role, POLICIES_BY_ROLE['viewer'])

            token = f'fake-jwt-{user[0]}-{int(time.time())}'
            return self._send_json(200, {
                'token': token,
                'user': user_profile,
                'config': {
                    'user': user_profile,
                    'policies': policies,
                    'skills': ENTERPRISE_SKILLS,
                    'auditEnabled': True,
                    'serverVersion': '1.0.0-enterprise',
                }
            })

        elif url.path == '/api/v1/auth/logout':
            return self._send_json(200, {'message': 'Logged out'})

        elif url.path == '/api/v1/audit/conversations':
            logs = data.get('logs', [])
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            inserted = 0
            for item in logs:
                c.execute('''
                    INSERT INTO audit_logs (
                        session_id, user_id, provider_id, model,
                        prompt_preview, messages_json, response_text,
                        prompt_tokens, completion_tokens, timestamp
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ''', (
                    item.get('session_id') or item.get('sessionId'),
                    item.get('user_id') or item.get('userId'),
                    item.get('provider_id') or item.get('providerId'),
                    item.get('model'),
                    item.get('prompt_preview') or item.get('promptPreview'),
                    item.get('messages_json') or item.get('messagesJson'),
                    item.get('response_text') or item.get('responseText'),
                    item.get('prompt_tokens') or item.get('promptTokens', 0),
                    item.get('completion_tokens') or item.get('completionTokens', 0),
                    item.get('timestamp', int(time.time()))
                ))
                inserted += 1
            conn.commit()
            conn.close()
            return self._send_json(200, {'count': inserted, 'status': 'success'})

        else:
            return self._send_json(404, {'message': 'Endpoint not found'})

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        auth = self.headers.get('Authorization', '')
        
        # 简单从 token 提取用户角色
        role = 'developer'
        if 'u-admin' in auth:
            role = 'admin'
        elif 'u-guest' in auth:
            role = 'viewer'

        if url.path == '/api/v1/client/config':
            return self._send_json(200, {
                'user': {
                    'id': f'u-{role}',
                    'username': role,
                    'email': f'{role}@enterprise.internal',
                    'role': role,
                    'tenantId': 'tenant-default',
                },
                'policies': POLICIES_BY_ROLE.get(role, POLICIES_BY_ROLE['viewer']),
                'skills': ENTERPRISE_SKILLS,
                'auditEnabled': True,
                'serverVersion': '1.0.0-enterprise',
            })

        elif url.path == '/api/v1/marketplace/skills':
            return self._send_json(200, ENTERPRISE_SKILLS)

        elif url.path == '/api/v1/audit/logs':
            # 管理员查看留存的审计日志
            conn = sqlite3.connect(DB_FILE)
            c = conn.cursor()
            c.execute('SELECT id, session_id, user_id, provider_id, model, prompt_tokens, completion_tokens, timestamp FROM audit_logs ORDER BY id DESC LIMIT 50')
            rows = c.fetchall()
            conn.close()
            results = [{
                'id': r[0], 'sessionId': r[1], 'userId': r[2], 'providerId': r[3],
                'model': r[4], 'promptTokens': r[5], 'completionTokens': r[6], 'timestamp': r[7]
            } for r in rows]
            return self._send_json(200, {'logs': results})

        else:
            return self._send_json(404, {'message': 'Endpoint not found'})

def run_server():
    init_db()
    server = HTTPServer(('127.0.0.1', PORT), EnterpriseHandler)
    print(f"Enterprise Management Center Server running on http://127.0.0.1:{PORT}")
    server.serve_forever()

if __name__ == '__main__':
    run_server()
