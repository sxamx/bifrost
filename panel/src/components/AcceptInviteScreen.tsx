import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { BrandMark } from './BrandMark';
import { InfoTip } from './InfoTip';

interface AcceptInviteScreenProps {
  inviteToken: string;
  onAccepted: () => Promise<void>;
  onCancelToLogin: () => void;
}

export const AcceptInviteScreen: React.FC<AcceptInviteScreenProps> = ({
  inviteToken,
  onAccepted,
  onCancelToLogin,
}) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedUsername = username.trim();
  const usernameInvalid = trimmedUsername.length < 3;
  const passwordInvalid = password.length < 8;
  const confirmInvalid = confirmPassword.length === 0 || password !== confirmPassword;
  const formValid = !usernameInvalid && !passwordInvalid && !confirmInvalid;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    setErrorMessage(null);

    if (!formValid) return;

    setSubmitting(true);
    try {
      await api.acceptInvitation(inviteToken, trimmedUsername, password);
      // Clean ?invite=... query param from address bar after one-time redemption
      window.history.replaceState({}, '', window.location.pathname);
      await onAccepted();
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError
          ? err.message
          : 'El enlace de invitación es inválido, ya fue utilizado o ha expirado.'
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="gate-wrapper">
      <section className="gate-card" aria-labelledby="accept-invite-heading">
        <div style={{ marginBottom: 24 }}>
          <BrandMark subtitle="Invitación de acceso" />
        </div>

        <div className="gate-badge">Enlace de un solo uso</div>

        <h1 id="accept-invite-heading" className="gate-title">
          Aceptar invitación
        </h1>
        <p className="gate-desc">
          Elige tu nombre de usuario y contraseña (sin necesidad de correo electrónico) para activar
          tu cuenta de invitado y generar tus propias llaves <code className="mono">sk-bf-…</code>.
        </p>

        {errorMessage ? (
          <div className="alert alert-error" role="alert" style={{ marginBottom: 18 }}>
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <form className="form-stack" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="invite-username" className="field-label">
              Nombre de usuario
              <InfoTip text="Mínimo 3 caracteres. Con este identificador iniciarás sesión en el panel." />
            </label>
            <input
              id="invite-username"
              type="text"
              autoComplete="username"
              autoFocus
              className={`input${submitted && usernameInvalid ? ' invalid' : ''}`}
              placeholder="ej. ana_dev"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
            {submitted && usernameInvalid ? (
              <span className="field-error">Debe contener al menos 3 caracteres.</span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="invite-password" className="field-label">
              Contraseña
            </label>
            <input
              id="invite-password"
              type="password"
              autoComplete="new-password"
              className={`input${submitted && passwordInvalid ? ' invalid' : ''}`}
              placeholder="Mínimo 8 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            {submitted && passwordInvalid ? (
              <span className="field-error">Debe contener al menos 8 caracteres.</span>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="invite-confirm" className="field-label">
              Confirmar contraseña
            </label>
            <input
              id="invite-confirm"
              type="password"
              autoComplete="new-password"
              className={`input${
                (submitted || confirmPassword.length > 0) && confirmInvalid ? ' invalid' : ''
              }`}
              placeholder="Repite tu contraseña"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              disabled={submitting}
            />
            {(submitted || confirmPassword.length > 0) && confirmInvalid ? (
              <span className="field-error">Las contraseñas no coinciden.</span>
            ) : null}
          </div>

          <button
            type="submit"
            className="btn btn-primary"
            disabled={submitting}
            style={{ width: '100%', marginTop: 4 }}
          >
            {submitting ? 'Activando cuenta…' : 'Crear cuenta de invitado y entrar'}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={submitting}
            onClick={() => {
              window.history.replaceState({}, '', window.location.pathname);
              onCancelToLogin();
            }}
          >
            ¿Ya tienes cuenta? Ir a Iniciar sesión
          </button>
        </form>
      </section>
    </main>
  );
};
