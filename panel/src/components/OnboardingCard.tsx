import React from 'react';
import { InfoTip } from './InfoTip';

interface OnboardingCardProps {
  isAdmin: boolean;
  onAddProvider: () => void;
  onCreateKey: () => void;
}

export const OnboardingCard: React.FC<OnboardingCardProps> = ({
  isAdmin,
  onAddProvider,
  onCreateKey,
}) => {
  return (
    <section className="onboarding-card" aria-labelledby="onboarding-title">
      <div className="onboarding-eyebrow">
        <span>Asistente de primer uso</span>
        <InfoTip text="Esta guía aparece mientras no haya proveedores configurados y se ocultará automáticamente al registrar el primero." />
      </div>

      <h2 id="onboarding-title" className="onboarding-title">
        Pon en marcha tu router Bifrost en tres pasos
      </h2>
      <p className="onboarding-lead">
        Bifrost centraliza el acceso a tus proveedores de IA bajo un único endpoint compatible con
        OpenAI, protegiendo tus credenciales reales cifradas en el servidor.
      </p>

      <div className="onboarding-steps">
        <div className="onboarding-step">
          <span className="step-num">1</span>
          <div className="step-title">Agrega tu primer proveedor desde el marketplace</div>
          <p className="step-desc">
            Instala adaptadores verificados desde el catálogo{' '}
            <code className="mono">bifrost-providers</code> sin reiniciar el núcleo.
          </p>
        </div>

        <div className="onboarding-step">
          <span className="step-num">2</span>
          <div className="step-title">Registra tu clave cifrada</div>
          <p className="step-desc">
            Guarda tus credenciales reales cifradas en <code className="mono">core/</code>. Jamás
            viajan de vuelta al navegador ni a tus editores.
          </p>
        </div>

        <div className="onboarding-step">
          <span className="step-num">3</span>
          <div className="step-title">
            Usa tu API key <code className="mono">sk-bf-…</code> en tus apps
          </div>
          <p className="step-desc">
            Genera una llave interna revocable para cada cliente (Zed, Cursor, CLI) apuntando a{' '}
            <code className="mono">/v1</code>.
          </p>
        </div>
      </div>

      <div className="onboarding-actions">
        <button type="button" className="btn btn-primary" onClick={onAddProvider}>
          Agregar proveedor
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCreateKey}>
          Crear API key interna
        </button>
        {!isAdmin ? (
          <span className="field-hint">
            Solicita a un administrador instalar el primer proveedor en esta instancia.
          </span>
        ) : null}
      </div>
    </section>
  );
};
