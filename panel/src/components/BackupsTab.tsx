import React, { useState } from 'react';
import { api, ApiError } from '../api';
import { InfoTip } from './InfoTip';

interface BackupsTabProps {
  onBackupRestored: () => Promise<void>;
}

export const BackupsTab: React.FC<BackupsTabProps> = ({ onBackupRestored }) => {
  // HU-25 Export State
  const [includeProvidersAndConfig, setIncludeProvidersAndConfig] = useState(true);
  const [includeProviderKeys, setIncludeProviderKeys] = useState(true);
  const [includeUsersAndQuotas, setIncludeUsersAndQuotas] = useState(true);
  const [includeNodes, setIncludeNodes] = useState(true);
  const [exportPassword, setExportPassword] = useState('');
  const [exportConfirm, setExportConfirm] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  // HU-25b Import State
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPassword, setImportPassword] = useState('');
  const [importing, setImporting] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  async function handleExportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setExportError(null);
    setExportMessage(null);

    if (
      !includeProvidersAndConfig &&
      !includeProviderKeys &&
      !includeUsersAndQuotas &&
      !includeNodes
    ) {
      setExportError('Selecciona al menos una sección para incluir en el archivo de respaldo.');
      return;
    }

    if (exportPassword.length < 8) {
      setExportError('La contraseña de cifrado del respaldo debe tener al menos 8 caracteres.');
      return;
    }

    if (exportPassword !== exportConfirm) {
      setExportError('Las contraseñas de cifrado no coinciden.');
      return;
    }

    setExporting(true);
    try {
      const blob = await api.exportBackup({
        password: exportPassword,
        includeProvidersAndConfig,
        includeProviderKeys,
        includeUsersAndQuotas,
        includeNodes,
      });

      const todayUtc = new Date().toISOString().slice(0, 10);
      const filename = `bifrost-backup-${todayUtc}.bifrost.enc`;
      const downloadUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = downloadUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(downloadUrl);

      setExportPassword('');
      setExportConfirm('');
      setExportMessage(`Respaldo cifrado «${filename}» descargado correctamente.`);
    } catch (err) {
      setExportError(
        err instanceof ApiError
          ? err.message
          : 'No fue posible generar el respaldo cifrado .bifrost.enc.'
      );
    } finally {
      setExporting(false);
    }
  }

  async function handleImportSubmit(e: React.FormEvent) {
    e.preventDefault();
    setImportError(null);
    setImportSuccess(null);

    if (!importFile) {
      setImportError('Selecciona un archivo .bifrost.enc para restaurar.');
      return;
    }
    if (!importPassword) {
      setImportError('Ingresa la contraseña con la que fue cifrado el respaldo.');
      return;
    }

    setImporting(true);
    try {
      const res = await api.importBackup(importFile, importPassword);
      setImportPassword('');
      setImportFile(null);
      await onBackupRestored();

      const parts: string[] = [];
      if (res.restored?.providers !== undefined) {
        parts.push(`${res.restored.providers} proveedores`);
      }
      if (res.restored?.providerKeys !== undefined) {
        parts.push(`${res.restored.providerKeys} claves`);
      }
      if (res.restored?.users !== undefined) {
        parts.push(`${res.restored.users} usuarios`);
      }
      if (res.restored?.nodes !== undefined) {
        parts.push(`${res.restored.nodes} nodos`);
      }

      setImportSuccess(
        res.message ||
          (parts.length > 0
            ? `Restauración completada con éxito (${parts.join(', ')}).`
            : 'Respaldo .bifrost.enc verificado e importado correctamente.')
      );
    } catch (err) {
      const serverReason =
        err instanceof ApiError
          ? err.message
          : 'Contraseña incorrecta o archivo .bifrost.enc dañado.';
      setImportError(
        `${serverReason} La base de datos actual no fue modificada y permanece intacta.`
      );
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Respaldos cifrados (.bifrost.enc)</h1>
          <p className="page-subtitle">
            Exporta o migra tu configuración a otra instancia en un único contenedor binario
            comprimido (<code className="mono">gzip</code>) y autenticado con{' '}
            <code className="mono">scrypt + AES-256-GCM</code>.
          </p>
        </div>
      </header>

      <div className="dual-cards-grid">
        {/* HU-25 Card 1: Export Encrypted Backup */}
        <section className="card" aria-labelledby="export-backup-heading">
          <div className="card-header">
            <h2 id="export-backup-heading" className="card-title">
              Exportar respaldo (.bifrost.enc)
              <InfoTip text="Las claves de proveedores se re-cifran con una clave derivada (scrypt) de la contraseña que definas aquí, permitiendo restaurarlas en otro servidor con distinta master.key." />
            </h2>
          </div>

          {exportMessage ? (
            <div className="alert alert-ok" role="status" style={{ marginBottom: 16 }}>
              <span>{exportMessage}</span>
            </div>
          ) : null}

          {exportError ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
              <span>{exportError}</span>
            </div>
          ) : null}

          <form onSubmit={handleExportSubmit} className="form-stack">
            <div className="field">
              <span className="field-label">Contenido a incluir en el paquete</span>
              <div
                style={{
                  background: 'var(--surface-muted)',
                  border: '1px solid var(--line)',
                  borderRadius: 14,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={includeProvidersAndConfig}
                    onChange={(e) => setIncludeProvidersAndConfig(e.target.checked)}
                    disabled={exporting}
                  />
                  <span>Proveedores instalados y catálogos</span>
                </label>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={includeProviderKeys}
                    onChange={(e) => setIncludeProviderKeys(e.target.checked)}
                    disabled={exporting}
                  />
                  <span>Claves y cuentas cifradas de proveedores</span>
                </label>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={includeUsersAndQuotas}
                    onChange={(e) => setIncludeUsersAndQuotas(e.target.checked)}
                    disabled={exporting}
                  />
                  <span>Usuarios invitados, modelos permitidos y cuotas</span>
                </label>

                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={includeNodes}
                    onChange={(e) => setIncludeNodes(e.target.checked)}
                    disabled={exporting}
                  />
                  <span>Configuración de nodos de salida</span>
                </label>
              </div>
            </div>

            <div className="field">
              <label htmlFor="export-pass" className="field-label">
                Contraseña de cifrado del respaldo
              </label>
              <input
                id="export-pass"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder="Mínimo 8 caracteres"
                value={exportPassword}
                onChange={(e) => setExportPassword(e.target.value)}
                disabled={exporting}
              />
            </div>

            <div className="field">
              <label htmlFor="export-pass-confirm" className="field-label">
                Confirmar contraseña de cifrado
              </label>
              <input
                id="export-pass-confirm"
                type="password"
                autoComplete="new-password"
                className="input"
                placeholder="Repite la contraseña"
                value={exportConfirm}
                onChange={(e) => setExportConfirm(e.target.value)}
                disabled={exporting}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={exporting}>
              {exporting ? 'Cifrando y empaquetando…' : 'Descargar respaldo .bifrost.enc'}
            </button>
          </form>
        </section>

        {/* HU-25b Card 2: Import / Restore Encrypted Backup */}
        <section className="card" aria-labelledby="import-backup-heading">
          <div className="card-header">
            <h2 id="import-backup-heading" className="card-title">
              Importar y restaurar respaldo
              <InfoTip text="Verifica primero la cabecera BIFROST1 y el tag de autenticación AES-256-GCM en memoria. Si la contraseña falla o el archivo está truncado, tu base de datos actual queda intacta." />
            </h2>
          </div>

          {importSuccess ? (
            <div className="alert alert-ok" role="status" style={{ marginBottom: 16 }}>
              <span>{importSuccess}</span>
            </div>
          ) : null}

          {importError ? (
            <div className="alert alert-error" role="alert" style={{ marginBottom: 16 }}>
              <span>{importError}</span>
            </div>
          ) : null}

          <form onSubmit={handleImportSubmit} className="form-stack">
            <div className="field">
              <label htmlFor="import-file-input" className="field-label">
                Archivo <code className="mono">.bifrost.enc</code>
              </label>
              <input
                id="import-file-input"
                type="file"
                accept=".enc,.bifrost.enc,application/octet-stream"
                className="input"
                disabled={importing}
                onChange={(e) => {
                  setImportFile(e.target.files?.[0] ?? null);
                  e.target.value = '';
                }}
              />
              {importFile ? (
                <span className="field-hint">
                  Seleccionado: <strong>{importFile.name}</strong> (
                  {(importFile.size / 1024).toFixed(1)} KB)
                </span>
              ) : null}
            </div>

            <div className="field">
              <label htmlFor="import-pass" className="field-label">
                Contraseña del archivo de respaldo
              </label>
              <input
                id="import-pass"
                type="password"
                autoComplete="current-password"
                className="input"
                placeholder="Contraseña definida al exportar"
                value={importPassword}
                onChange={(e) => setImportPassword(e.target.value)}
                disabled={importing}
              />
            </div>

            <button type="submit" className="btn btn-primary" disabled={importing}>
              {importing ? 'Verificando e importando…' : 'Restaurar respaldo cifrado'}
            </button>
          </form>
        </section>
      </div>
    </>
  );
};
