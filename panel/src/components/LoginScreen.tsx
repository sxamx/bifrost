import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { BrandMark } from './BrandMark';
import { InfoTip } from './InfoTip';

interface LoginScreenProps {
  onLoginSuccess: () => Promise<void>;
}

export const LoginScreen: React.FC<LoginScreenProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMessage(null);

    const cleanUser = username.trim();
    if (!cleanUser || !password) {
      setErrorMessage('Ingresa tu usuario y contraseña para continuar.');
      return;
    }

    setSubmitting(true);
    try {
      await api.login(cleanUser, password);
      await onLoginSuccess();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setErrorMessage('Credenciales inválidas. Verifica tu usuario y contraseña.');
        } else {
          setErrorMessage(err.message);
        }
      } else {
        setErrorMessage('No fue posible conectar con el servidor de Bifrost.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="gate-wrapper">
      <section className="gate-card" aria-labelledby="login-heading">
        <div style={{ marginBottom: 24 }}>
          <BrandMark subtitle="Panel de control local" />
        </div>

        <h1 id="login-heading" className="gate-title">
          Iniciar sesión
        </h1>
        <p className="gate-desc">
          Accede como administrador o invitado para gestionar tus llaves{' '}
          <code className="mono">sk-bf-…</code> y revisar el estado del router.
        </p>

        {errorMessage ? (
          <div className="alert alert-error" role="alert" style={{ marginBottom: 18 }}>
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <form className="form-stack" onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="login-username" className="field-label">
              Usuario
            </label>
            <input
              id="login-username"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              className="input"
              placeholder="Tu nombre de usuario"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
          </div>

          <div className="field">
            <label htmlFor="login-password" className="field-label">
              Contraseña
              <InfoTip text="Tu sesión se mantiene segura mediante cookies HttpOnly gestionadas por core/, sin exponer tokens en localStorage." />
            </label>
            <input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ width: '100%', marginTop: 6 }}
          >
            {submitting ? 'Verificando…' : 'Iniciar sesión'}
          </button>
        </form>
      </section>
    </main>
  );
};
