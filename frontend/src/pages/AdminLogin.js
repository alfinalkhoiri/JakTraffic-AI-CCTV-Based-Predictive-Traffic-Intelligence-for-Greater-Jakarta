import React, { useState, useEffect } from 'react';

const ADMIN_PASS = process.env.REACT_APP_ADMIN_PASS || 'dishub2026';

export default function AdminLogin() {
  const [pw, setPw]       = useState('');
  const [err, setErr]     = useState('');
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem('admin_auth') === '1') window.location.replace('/admin');
  }, []);

  const handleSubmit = (e) => {
    e.preventDefault();
    if (pw === ADMIN_PASS) {
      sessionStorage.setItem('admin_auth', '1');
      window.location.replace('/admin');
    } else {
      setErr('Password salah');
      setShake(true);
      setPw('');
      setTimeout(() => setShake(false), 600);
    }
  };

  return (
    <div style={{ minHeight:'100vh', background:'#030811', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'system-ui,-apple-system,sans-serif', color:'#f0f9ff' }}>
      <div style={{ width:360, background:'rgba(15,24,48,0.97)', border:'1px solid rgba(245,158,11,.2)', borderRadius:16, padding:36, boxShadow:'0 24px 64px rgba(0,0,0,.7)' }}>
        <div style={{ textAlign:'center', marginBottom:28 }}>
          <div style={{ width:52, height:52, borderRadius:13, background:'linear-gradient(135deg,#f59e0b,#d97706)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:26, margin:'0 auto 14px', boxShadow:'0 0 28px rgba(245,158,11,.4)' }}>⚙</div>
          <div style={{ fontSize:18, fontWeight:800, letterSpacing:-.3 }}>Panel Operator Dishub</div>
          <div style={{ fontSize:12, color:'#64748b', marginTop:4 }}>JakTraffic AI — Akses Terbatas</div>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom:14 }}>
            <label style={{ display:'block', fontSize:10, fontWeight:700, color:'#94a3b8', marginBottom:6, letterSpacing:.8, textTransform:'uppercase' }}>Password Operator</label>
            <input
              type="password"
              value={pw}
              onChange={e => { setPw(e.target.value); setErr(''); }}
              placeholder="Masukkan password"
              autoFocus
              style={{
                width:'100%', boxSizing:'border-box',
                background:'rgba(255,255,255,.06)',
                border:`1px solid ${err ? '#ef4444' : 'rgba(255,255,255,.12)'}`,
                borderRadius:8, padding:'11px 14px', color:'#f0f9ff', fontSize:13, outline:'none',
                animation: shake ? 'shake .5s ease' : 'none',
                transition:'border .15s',
              }}
            />
            {err && <div style={{ fontSize:11, color:'#ef4444', marginTop:5 }}>❌ {err}</div>}
          </div>

          <button
            type="submit"
            style={{ width:'100%', background:'linear-gradient(135deg,#f59e0b,#d97706)', border:'none', borderRadius:8, padding:'11px 0', fontSize:13, fontWeight:700, color:'#030811', cursor:'pointer', marginTop:6, letterSpacing:.2 }}
          >
            Masuk ke Dashboard →
          </button>
        </form>

        <div style={{ marginTop:20, padding:'12px 14px', background:'rgba(245,158,11,.07)', border:'1px solid rgba(245,158,11,.14)', borderRadius:8 }}>
          <div style={{ fontSize:10, color:'#94a3b8', lineHeight:1.7 }}>
            🔒 Akses dibatasi untuk operator Dishub dan administrator sistem. Hubungi admin untuk mendapatkan password.
          </div>
        </div>

        <div style={{ marginTop:16, textAlign:'center' }}>
          <a href="/" style={{ fontSize:11, color:'#475569', textDecoration:'none' }}>← Kembali ke Peta</a>
        </div>
      </div>
      <style>{`@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-7px)}40%,80%{transform:translateX(7px)}}`}</style>
    </div>
  );
}
