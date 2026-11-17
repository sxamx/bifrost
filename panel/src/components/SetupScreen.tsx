import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { BrandMark } from './BrandMark';
import { InfoTip } from './InfoTip';

interface SetupScreenProps {
  onSetupComplete: () => Promise<void>;
}

export const SetupScreen: React.FC<SetupScreenProps> = ({ onSetupComplete }) => {
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

    if (!formValid) {
      return;
    }

    setSubmitting(true);
    try {
      await api.setupAdmin(trimmedUsername, password);
      await onSetupComplete();
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('No se pudo inicializar la cuenta de administrador. Intenta de nuevo.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="gate-wrapper">
      <section className="gate-card" aria-labelledby="setup-heading">
        <div style={{ marginBottom: 24 }}>
          <BrandMark subtitle="Puente unificado de modelos IA" />
        </div>

        <div className="gate-badge">Configuración inicial obligatoria</div>

        <h1 id="setup-heading" className="gate-title">
          Crear cuenta de administrador
        </h1>
        <p className="gate-desc">
          Bienvenido a Bifrost. Antes de usar el gateway o generar llaves internas, protege tu
          instancia configurando la cuenta principal de administración.
        </p>

        {errorMessage ? (
          <div className="alert alert-error" role="alert" style={{ marginBottom: 18 }}>
            <span>{errorMessage}</span>
          </div>
        ) : null}

        <form className="form-stack" onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="setup-username" className="field-label">
              Nombre de usuario
              <InfoTip text="Identificador con el que iniciarás sesión en el panel. Mínimo 3 caracteres." />
            </label>
            <input
              id="setup-username"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              className={`input${submitted && usernameInvalid ? ' invalid' : ''}`}
              placeholder="ej. admin"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
            />
            {submitted && usernameInvalid ? (
              <span className="field-error">
                El nombre de usuario debe tener al menos 3 caracteres.
              </span>
            ) : (
              <span className="field-hint">Mínimo 3 caracteres.</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="setup-password" className="field-label">
              Contraseña maestra de acceso
              <InfoTip text="Se almacena con hash seguro en core/ y la sesión viaja mediante cookie HttpOnly. Nunca se guarda en el navegador." />
            </label>
            <input
              id="setup-password"
              name="password"
              type="password"
              autoComplete="new-password"
              className={`input${submitted && passwordInvalid ? ' invalid' : ''}`}
              placeholder="Mínimo 8 caracteres"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={submitting}
            />
            {submitted && passwordInvalid ? (
              <span className="field-error">La contraseña debe tener al menos 8 caracteres.</span>
            ) : (
              <span className="field-hint">Usa al menos 8 caracteres.</span>
            )}
          </div>

          <div className="field">
            <label htmlFor="setup-confirm" className="field-label">
              Confirmar contraseña
            </label>
            <input
              id="setup-confirm"
              name="confirmPassword"
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
            style={{ width: '100%', marginTop: 6 }}
          >
            {submitting ? 'Inicializando Bifrost…' : 'Crear cuenta de administrador'}
          </button>
        </form>
      </section>
    </main>
  );
};
