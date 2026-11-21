import React, { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { copyTextToClipboard } from '../clipboard';
import type {
  CreateInvitationResult,
  InvitationItem,
  ManagedUserItem,
  ProviderModelItem,
  QuotaResetMode,
} from '../types';
import { InfoTip } from './InfoTip';

function formatShortDate(ts: number | undefined | null): string {
  if (!ts || !Number.isFinite(ts) || ts <= 0) return '—';
  const ms = ts < 1_000_000_000_000 ? ts * 1000 : ts;
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

export const UsersTab: React.FC = () => {
  const [users, setUsers] = useState<ManagedUserItem[]>([]);
  const [invitations, setInvitations] = useState<InvitationItem[]>([]);
  const [models, setModels] = useState<ProviderModelItem[]>([]);
  const [loading, setLoading] = useState(true);

  // Create Invitation Form State (HU-04)
  const [inviteDailyLimit, setInviteDailyLimit] = useState(50000);
  const [inviteResetMode, setInviteResetMode] = useState<QuotaResetMode>('utc_midnight');
  const [inviteWildcardAll, setInviteWildcardAll] = useState(true);
  const [inviteSelectedModels, setInviteSelectedModels] = useState<string[]>([]);
  const [creatingInvite, setCreatingInvite] = useState(false);

  // One-time revealed invite URL
  const [createdInvite, setCreatedInvite] = useState<CreateInvitationResult | null>(null);
  const [copiedInviteUrl, setCopiedInviteUrl] = useState(false);

  // Edit Guest User Modal State (HU-05)
  const [editingUser, setEditingUser] = useState<ManagedUserItem | null>(null);
  const [editLimitInput, setEditLimitInput] = useState('');
  const [editResetMode, setEditResetMode] = useState<QuotaResetMode>('utc_midnight');
  const [editWildcardAll, setEditWildcardAll] = useState(true);
  const [editSelectedModels, setEditSelectedModels] = useState<string[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  // Delete Guest User & Invitation Confirmation State
  const [userToDelete, setUserToDelete] = useState<ManagedUserItem | null>(null);
  const [deletingUser, setDeletingUser] = useState(false);
  const [deletingInviteId, setDeletingInviteId] = useState<string | null>(null);

  // HU-33 & HU-35 Model search + strict quota state
  const [inviteEnforceStrict, setInviteEnforceStrict] = useState(false);
  const [inviteModelSearch, setInviteModelSearch] = useState('');
  const [editEnforceStrict, setEditEnforceStrict] = useState(false);
  const [editModelSearch, setEditModelSearch] = useState('');

  const [banner, setBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    const [usersRes, invRes, modelsRes] = await Promise.allSettled([
      api.getUsers(),
      api.getInvitations(),
      api.getModels(),
    ]);

    if (usersRes.status === 'fulfilled') setUsers(usersRes.value);
    if (invRes.status === 'fulfilled') setInvitations(invRes.value);
    if (modelsRes.status === 'fulfilled') {
      setModels(modelsRes.value.filter((m) => m.active !== false));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function toggleModelInArray(list: string[], fullId: string): string[] {
    return list.includes(fullId) ? list.filter((x) => x !== fullId) : [...list, fullId];
  }

  async function handleCreateInvitation(e: React.FormEvent) {
    e.preventDefault();
    setErrorBanner(null);
    setBanner(null);

    if (!Number.isFinite(inviteDailyLimit) || inviteDailyLimit <= 0) {
      setErrorBanner('Define una cuota diaria positiva en tokens para el invitado.');
      return;
    }

    const allowedModels = inviteWildcardAll ? ['*'] : inviteSelectedModels;
    if (!inviteWildcardAll && allowedModels.length === 0) {
      setErrorBanner(
        'Selecciona al menos un modelo permitido o habilita «Todos los modelos activos (*)».'
      );
      return;
    }

    setCreatingInvite(true);
    try {
      const res = await api.createInvitation({
        dailyTokenLimit: Math.floor(inviteDailyLimit),
        quotaResetMode: inviteResetMode,
        enforceStrictQuota: inviteEnforceStrict,
        allowedModels,
      });
      setCreatedInvite(res);
      setCopiedInviteUrl(false);
      await loadData();
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError ? err.message : 'No fue posible generar la invitación.'
      );
    } finally {
      setCreatingInvite(false);
    }
  }

  function openEditModal(u: ManagedUserItem) {
    setEditingUser(u);
    setEditLimitInput(u.dailyTokenLimit !== null ? String(u.dailyTokenLimit) : '50000');
    setEditResetMode(u.quotaResetMode);
    setEditEnforceStrict(Boolean(u.enforceStrictQuota));
    setEditModelSearch('');
    const hasStar = u.allowedModels.includes('*') || u.allowedModels.length === 0;
    setEditWildcardAll(hasStar);
    setEditSelectedModels(hasStar ? [] : [...u.allowedModels]);
  }

  async function handleDeleteInvitation(invId: string) {
    setErrorBanner(null);
    setDeletingInviteId(invId);
    try {
      await api.deleteInvitation(invId);
      setBanner('Invitación pendiente eliminada.');
      await loadData();
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError ? err.message : 'No se pudo eliminar la invitación.'
      );
    } finally {
      setDeletingInviteId(null);
    }
  }

  async function handleSaveUserEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingUser) return;
    setErrorBanner(null);

    const parsedLimit = Number(editLimitInput.trim());
    if (!Number.isFinite(parsedLimit) || parsedLimit <= 0) {
      setErrorBanner('La cuota diaria del invitado debe ser mayor a 0 tokens.');
      return;
    }

    const allowedModels = editWildcardAll ? ['*'] : editSelectedModels;
    if (!editWildcardAll && allowedModels.length === 0) {
      setErrorBanner('Selecciona al menos un modelo permitido para el usuario.');
      return;
    }

    setSavingEdit(true);
    try {
      await api.updateUserQuotaAndModels(editingUser.id, {
        dailyTokenLimit: Math.floor(parsedLimit),
        quotaResetMode: editResetMode,
        enforceStrictQuota: editEnforceStrict,
        allowedModels,
      });
      const updatedName = editingUser.username;
      setEditingUser(null);
      await loadData();
      setBanner(`Cuota y modelos actualizados para «${updatedName}».`);
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError
          ? err.message
          : 'Error al actualizar los permisos del usuario.'
      );
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleConfirmDeleteUser() {
    if (!userToDelete) return;
    setDeletingUser(true);
    setErrorBanner(null);

    try {
      await api.deleteUser(userToDelete.id);
      const removedUsername = userToDelete.username;
      setUserToDelete(null);
      await loadData();
      setBanner(`Usuario «${removedUsername}» y sus llaves internas han sido revocados.`);
    } catch (err) {
      setErrorBanner(
        err instanceof ApiError ? err.message : 'No fue posible eliminar el usuario.'
      );
    } finally {
      setDeletingUser(false);
    }
  }

  async function handleCopyInviteLink(url: string) {
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopiedInviteUrl(true);
      window.setTimeout(() => setCopiedInviteUrl(false), 2400);
    } else {
      setCopiedInviteUrl(false);
    }
  }

  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Usuarios, Invitaciones y Cuotas</h1>
          <p className="page-subtitle">
            Comparte acceso controlado mediante enlaces de un solo uso sin pedir correo y asigna
            cuotas diarias en UTC y modelos permitidos por invitado.
          </p>
        </div>
      </header>

      {banner ? (
        <div className="alert alert-ok" role="status">
          <span>{banner}</span>
        </div>
      ) : null}

      {errorBanner ? (
        <div className="alert alert-error" role="alert">
          <span>{errorBanner}</span>
        </div>
      ) : null}

      {/* One-time Invite Link Reveal Banner */}
      {createdInvite ? (
        <section className="reveal-banner" role="region" aria-label="Enlace de invitación creado">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <h2 className="card-title" style={{ marginBottom: 4 }}>
                Enlace de invitación de un solo uso listo
              </h2>
              <p style={{ color: 'var(--partial)', fontWeight: 600, fontSize: '0.88rem' }}>
                Envía este enlace a tu colaborador ahora. Por seguridad, el token solo se muestra al
                generarlo y caduca tras su primer uso.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setCreatedInvite(null)}
            >
              Cerrar aviso
            </button>
          </div>

          <div className="reveal-key-row">
            <code className="reveal-key-value">{createdInvite.inviteUrl}</code>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void handleCopyInviteLink(createdInvite.inviteUrl)}
            >
              {copiedInviteUrl ? '✓ Enlace copiado' : 'Copiar enlace'}
            </button>
          </div>
        </section>
      ) : null}

      {/* HU-04 Create Single-Use Invitation Card */}
      <section className="card" aria-labelledby="create-invite-heading">
        <div className="card-header">
          <h2 id="create-invite-heading" className="card-title">
            Generar enlace de invitación (un solo uso)
            <InfoTip text="El invitado definirá su propio usuario y contraseña al abrir el enlace. Solo verá sus modelos permitidos, su cuota, Métricas, Playground y sus propias llaves sk-bf-…." />
          </h2>
        </div>

        <form onSubmit={handleCreateInvitation} className="form-stack">
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
              gap: 16,
            }}
          >
            <div className="field">
              <label htmlFor="inv-daily-limit" className="field-label">
                Cuota diaria (tokens / día)
              </label>
              <input
                id="inv-daily-limit"
                type="number"
                min={100}
                step={1000}
                className="input mono"
                value={inviteDailyLimit}
                onChange={(e) => setInviteDailyLimit(Number(e.target.value))}
                disabled={creatingInvite}
              />
            </div>

            <div className="field">
              <label htmlFor="inv-reset-mode" className="field-label">
                Modo de reinicio de cuota
                <InfoTip text="Calculado siempre con el reloj UTC del servidor para impedir manipulación desde el cliente." />
              </label>
              <select
                id="inv-reset-mode"
                className="input"
                value={inviteResetMode}
                onChange={(e) => setInviteResetMode(e.target.value as QuotaResetMode)}
                disabled={creatingInvite}
              >
                <option value="utc_midnight">Medianoche fija (00:00 UTC)</option>
                <option value="rolling_24h">Ventana móvil de 24 horas</option>
              </select>
            </div>
          </div>

          <div className="field">
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={inviteEnforceStrict}
                onChange={(e) => setInviteEnforceStrict(e.target.checked)}
                disabled={creatingInvite}
              />
              <span>
                Cuota estricta (bloquear de inmediato al alcanzar el límite sin margen extra)
              </span>
            </label>
          </div>

          <div className="field">
            <span className="field-label">Modelos permitidos para este invitado</span>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={inviteWildcardAll}
                onChange={(e) => setInviteWildcardAll(e.target.checked)}
                disabled={creatingInvite}
              />
              <span>Permitir todos los modelos activos del router (*)</span>
            </label>

            {!inviteWildcardAll ? (
              models.length === 0 ? (
                <p className="field-hint">
                  Aún no hay modelos detectados. Instala y sincroniza un proveedor o usa comodín
                  (*).
                </p>
              ) : (
                <>
                  <input
                    type="search"
                    className="input"
                    style={{ marginBottom: 8 }}
                    placeholder={`Buscar modelos… (${inviteSelectedModels.length} seleccionados)`}
                    value={inviteModelSearch}
                    onChange={(e) => setInviteModelSearch(e.target.value)}
                  />
                  <div className="models-checklist-box">
                    {models
                      .filter((m) => {
                        const q = inviteModelSearch.trim().toLowerCase();
                        return (
                          !q ||
                          m.fullId.toLowerCase().includes(q) ||
                          m.name.toLowerCase().includes(q)
                        );
                      })
                      .map((m) => (
                        <label
                          key={m.fullId}
                          className="checkbox-row"
                          style={{ fontSize: '0.82rem' }}
                        >
                          <input
                            type="checkbox"
                            checked={inviteSelectedModels.includes(m.fullId)}
                            onChange={() =>
                              setInviteSelectedModels((prev) =>
                                toggleModelInArray(prev, m.fullId)
                              )
                            }
                          />
                          <span className="mono">{m.fullId}</span>
                        </label>
                      ))}
                  </div>
                </>
              )
            ) : null}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={creatingInvite}>
              {creatingInvite ? 'Generando enlace…' : 'Crear enlace de invitación'}
            </button>
          </div>
        </form>
      </section>

      {/* HU-05 Users & Quotas Management Table */}
      <section className="card" aria-labelledby="users-table-heading">
        <div className="card-header">
          <h2 id="users-table-heading" className="card-title">
            Cuentas registradas ({users.length})
          </h2>
        </div>

        {loading && users.length === 0 ? (
          <p className="field-hint">Cargando cuentas de usuario…</p>
        ) : users.length === 0 ? (
          <p className="field-hint">No se encontraron usuarios registrados.</p>
        ) : (
          <div className="table-wrap">
            <table className="bf-table">
              <thead>
                <tr>
                  <th>Usuario</th>
                  <th>Rol</th>
                  <th>Cuota diaria</th>
                  <th>Reinicio</th>
                  <th>Modelos asignados</th>
                  <th>Creado</th>
                  <th style={{ textAlign: 'right' }}>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isAdminRow = u.role === 'admin';
                  const hasAllModels =
                    isAdminRow || u.allowedModels.includes('*') || u.allowedModels.length === 0;

                  return (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 700 }}>{u.username}</td>
                      <td>
                        <span className={`role-badge ${isAdminRow ? 'admin' : 'guest'}`}>
                          {isAdminRow ? 'admin' : 'invitado'}
                        </span>
                      </td>
                      <td className="mono">
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span>
                            {isAdminRow || u.dailyTokenLimit === null
                              ? 'Ilimitado'
                              : `${u.dailyTokenLimit.toLocaleString('es-ES')} tok`}
                          </span>
                          {!isAdminRow && u.enforceStrictQuota ? (
                            <span className="status-badge rate_limited">Estricta</span>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ color: 'var(--sub)', fontSize: '0.85rem' }}>
                        {u.quotaResetMode === 'rolling_24h' ? 'Móvil 24 h' : '00:00 UTC'}
                      </td>
                      <td>
                        {hasAllModels ? (
                          <span className="meta-tag verified">Todos (*)</span>
                        ) : (
                          <span className="meta-tag accent">
                            {u.allowedModels.length}{' '}
                            {u.allowedModels.length === 1 ? 'modelo' : 'modelos'}
                          </span>
                        )}
                      </td>
                      <td style={{ color: 'var(--sub)', fontSize: '0.85rem' }}>
                        {formatShortDate(u.createdAt)}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {isAdminRow ? (
                          <span className="field-hint">Cuenta principal</span>
                        ) : (
                          <div
                            style={{
                              display: 'inline-flex',
                              gap: 8,
                              justifyContent: 'flex-end',
                            }}
                          >
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => openEditModal(u)}
                            >
                              Editar cuota / modelos
                            </button>
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              onClick={() => setUserToDelete(u)}
                            >
                              Revocar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Pending / Historical Invitations Summary */}
      {invitations.length > 0 ? (
        <section className="card" aria-labelledby="invitations-list-heading">
          <div className="card-header">
            <h2 id="invitations-list-heading" className="card-title">
              Historial de invitaciones ({invitations.length})
            </h2>
          </div>
          <div className="table-wrap">
            <table className="bf-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Cuota asignada</th>
                  <th>Estado</th>
                  <th>Expira</th>
                  <th style={{ textAlign: 'right' }}>Acción</th>
                </tr>
              </thead>
              <tbody>
                {invitations.map((inv) => (
                  <tr key={inv.id}>
                    <td>
                      <code className="key-prefix-pill">{inv.id.slice(0, 10)}</code>
                    </td>
                    <td className="mono">
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span>{inv.dailyTokenLimit.toLocaleString('es-ES')} tok/día</span>
                        {inv.enforceStrictQuota ? (
                          <span className="status-badge rate_limited">Estricta</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {inv.usedAt ? (
                        <span className="status-badge offline">Canjeada</span>
                      ) : (
                        <span className="status-badge active">Pendiente</span>
                      )}
                    </td>
                    <td style={{ color: 'var(--sub)', fontSize: '0.85rem' }}>
                      {formatShortDate(inv.expiresAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {!inv.usedAt ? (
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={deletingInviteId === inv.id}
                          onClick={() => void handleDeleteInvitation(inv.id)}
                        >
                          {deletingInviteId === inv.id ? 'Eliminando…' : 'Eliminar'}
                        </button>
                      ) : (
                        <span className="field-hint">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* HU-05 Edit Guest User Quota & Allowed Models Modal */}
      {editingUser ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-guest-modal-title"
          onClick={() => {
            if (!savingEdit) setEditingUser(null);
          }}
        >
          <div
            className="modal-card"
            style={{ maxWidth: 580 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="edit-guest-modal-title" className="card-title">
              Configurar invitado «{editingUser.username}»
            </h2>

            <form onSubmit={handleSaveUserEdit} className="form-stack">
              <div className="field">
                <label htmlFor="edit-user-limit" className="field-label">
                  Cuota diaria de tokens
                </label>
                <input
                  id="edit-user-limit"
                  type="number"
                  min={1}
                  className="input mono"
                  value={editLimitInput}
                  onChange={(e) => setEditLimitInput(e.target.value)}
                  disabled={savingEdit}
                />
              </div>

              <div className="field">
                <label htmlFor="edit-user-reset" className="field-label">
                  Modo de reinicio
                </label>
                <select
                  id="edit-user-reset"
                  className="input"
                  value={editResetMode}
                  onChange={(e) => setEditResetMode(e.target.value as QuotaResetMode)}
                  disabled={savingEdit}
                >
                  <option value="utc_midnight">Medianoche fija (00:00 UTC)</option>
                  <option value="rolling_24h">Ventana móvil de 24 horas</option>
                </select>
              </div>

              <div className="field">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editEnforceStrict}
                    onChange={(e) => setEditEnforceStrict(e.target.checked)}
                    disabled={savingEdit}
                  />
                  <span>Cuota estricta (sin margen extra al agotar límite)</span>
                </label>
              </div>

              <div className="field">
                <span className="field-label">Modelos permitidos</span>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={editWildcardAll}
                    onChange={(e) => setEditWildcardAll(e.target.checked)}
                    disabled={savingEdit}
                  />
                  <span>Todos los modelos activos (*)</span>
                </label>

                {!editWildcardAll ? (
                  <>
                    <input
                      type="search"
                      className="input"
                      style={{ marginBottom: 8 }}
                      placeholder={`Buscar modelos… (${editSelectedModels.length} seleccionados)`}
                      value={editModelSearch}
                      onChange={(e) => setEditModelSearch(e.target.value)}
                    />
                    <div className="models-checklist-box">
                      {models
                        .filter((m) => {
                          const q = editModelSearch.trim().toLowerCase();
                          return (
                            !q ||
                            m.fullId.toLowerCase().includes(q) ||
                            m.name.toLowerCase().includes(q)
                          );
                        })
                        .map((m) => (
                          <label
                            key={m.fullId}
                            className="checkbox-row"
                            style={{ fontSize: '0.82rem' }}
                          >
                            <input
                              type="checkbox"
                              checked={editSelectedModels.includes(m.fullId)}
                              onChange={() =>
                                setEditSelectedModels((prev) =>
                                  toggleModelInArray(prev, m.fullId)
                                )
                              }
                            />
                            <span className="mono">{m.fullId}</span>
                          </label>
                        ))}
                    </div>
                  </>
                ) : null}
              </div>

              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={savingEdit}
                  onClick={() => setEditingUser(null)}
                >
                  Cancelar
                </button>
                <button type="submit" className="btn btn-primary" disabled={savingEdit}>
                  {savingEdit ? 'Guardando…' : 'Guardar cambios'}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}

      {/* Confirm Guest Revocation Modal */}
      {userToDelete ? (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="revoke-user-modal-title"
          onClick={() => {
            if (!deletingUser) setUserToDelete(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h2
              id="revoke-user-modal-title"
              className="card-title"
              style={{ color: 'var(--err)' }}
            >
              Revocar acceso de «{userToDelete.username}»
            </h2>
            <p style={{ color: 'var(--sub)', fontSize: '0.93rem' }}>
              Se eliminará la cuenta de invitado <strong>{userToDelete.username}</strong> junto con
              todas sus sesiones activas y llaves <code className="mono">sk-bf-…</code> asociadas.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={deletingUser}
                onClick={() => setUserToDelete(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={deletingUser}
                onClick={handleConfirmDeleteUser}
              >
                {deletingUser ? 'Revocando…' : 'Sí, eliminar invitado'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
