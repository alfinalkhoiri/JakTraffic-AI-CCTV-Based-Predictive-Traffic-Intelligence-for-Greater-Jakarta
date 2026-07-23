import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './index.css';
import App from './App';
import Admin from './pages/Admin';
import AdminLogin from './pages/AdminLogin';

class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(e) { return { error: e }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ background: '#0f172a', color: '#f8fafc', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', padding: 32, fontFamily: 'monospace' }}>
          <h2 style={{ color: '#ef4444', marginBottom: 16 }}>⚠ Runtime Error</h2>
          <pre style={{ background: '#1e293b', padding: 16, borderRadius: 8, maxWidth: 800, overflowX: 'auto', fontSize: 13, color: '#fca5a5' }}>
            {this.state.error.toString()}
            {'\n\n'}
            {this.state.error.stack?.slice(0, 1000)}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ErrorBoundary>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin-login" element={<AdminLogin />} />
      </Routes>
    </BrowserRouter>
  </ErrorBoundary>
);
