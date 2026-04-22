const qs = (id) => document.getElementById(id);

const state = {
    lastCreatedToken: ''
};

const pretty = (value) => {
    try {
        return JSON.stringify(value, null, 2);
    } catch (_) {
        return String(value);
    }
};

const setResultBox = (value) => {
    const el = qs('resultBox');
    el.textContent = typeof value === 'string' ? value : pretty(value);
};

const syncAdminCodeVisibility = () => {
    const role = qs('newRole').value;
    const wrap = qs('adminCodeWrap');
    wrap.style.display = role === 'admin' ? '' : 'none';
};

const createUser = async () => {
    const username = (qs('newUsername').value || '').trim();
    const password = (qs('newPassword').value || '').trim();
    const role = qs('newRole').value;
    const adminCode = (qs('adminCode').value || '').trim();

    if (!username || !password) {
        setResultBox('用户名和密码不能为空');
        return;
    }
    if (role === 'admin' && !adminCode) {
        setResultBox('创建管理员需要填写管理员邀请码');
        return;
    }

    qs('createBtn').disabled = true;
    qs('copyBtn').disabled = true;
    state.lastCreatedToken = '';
    setResultBox('创建中...');

    try {
        const payload = {
            username,
            password,
            roles: role,
            admin_code: role === 'admin' ? adminCode : null
        };
        const res = await fetch('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(data.detail || `HTTP ${res.status}`);
        }
        state.lastCreatedToken = data.access_token || '';
        qs('copyBtn').disabled = !state.lastCreatedToken;
        setResultBox(data);
    } catch (err) {
        setResultBox(`创建失败：${err?.message || String(err)}`);
    } finally {
        qs('createBtn').disabled = false;
    }
};

const copyToken = async () => {
    if (!state.lastCreatedToken) return;
    try {
        await navigator.clipboard.writeText(state.lastCreatedToken);
        setResultBox({ message: '已复制新用户 Token', access_token: state.lastCreatedToken });
    } catch (err) {
        setResultBox(`复制失败：${err?.message || String(err)}`);
    }
};

const init = () => {
    qs('newRole').addEventListener('change', syncAdminCodeVisibility);
    qs('createBtn').addEventListener('click', createUser);
    qs('copyBtn').addEventListener('click', copyToken);
    syncAdminCodeVisibility();
};

window.addEventListener('DOMContentLoaded', init);
