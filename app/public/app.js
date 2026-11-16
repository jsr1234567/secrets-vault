const sessionToken = document.querySelector('meta[name="vault-session"]').content;

const state = {
  unlocked: false,
  loading: false,
  names: [],
  query: new URLSearchParams(window.location.search).get("q") ?? "",
  dialogMode: "create",
  selectedName: "",
  revealedName: "",
  revealedValue: "",
  revealLoadingName: "",
  revealErrorName: "",
  revealError: "",
  copyLoadingName: "",
};

const elements = {
  addKey: document.querySelector("#add-key"),
  count: document.querySelector("#key-count"),
  deleteConfirmation: document.querySelector("#delete-confirmation"),
  deleteConfirmationError: document.querySelector("#delete-confirmation-error"),
  deleteCopy: document.querySelector("#delete-dialog-copy"),
  deleteDialog: document.querySelector("#delete-dialog"),
  deleteForm: document.querySelector("#delete-form"),
  deleteFormError: document.querySelector("#delete-form-error"),
  deleteKeyName: document.querySelector("#delete-key-name"),
  deleteSubmit: document.querySelector("#delete-key"),
  emptyAction: document.querySelector("#empty-action"),
  emptyCopy: document.querySelector("#empty-copy"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  errorState: document.querySelector("#error-state"),
  keyConfirmValue: document.querySelector("#key-confirm-value"),
  keyConfirmValueError: document.querySelector("#key-confirm-value-error"),
  keyDialog: document.querySelector("#key-dialog"),
  keyDialogCopy: document.querySelector("#key-dialog-copy"),
  keyDialogEyebrow: document.querySelector("#key-dialog-eyebrow"),
  keyDialogTitle: document.querySelector("#key-dialog-title"),
  keyForm: document.querySelector("#key-form"),
  keyFormError: document.querySelector("#key-form-error"),
  keyList: document.querySelector("#key-list"),
  keyName: document.querySelector("#key-name"),
  keyNameError: document.querySelector("#key-name-error"),
  keyNameHint: document.querySelector("#key-name-hint"),
  keySearch: document.querySelector("#key-search"),
  keyValue: document.querySelector("#key-value"),
  keyValueError: document.querySelector("#key-value-error"),
  loadingState: document.querySelector("#loading-state"),
  lockedState: document.querySelector("#locked-state"),
  renameCurrentName: document.querySelector("#rename-current-name"),
  renameDialog: document.querySelector("#rename-dialog"),
  renameForm: document.querySelector("#rename-form"),
  renameFormError: document.querySelector("#rename-form-error"),
  renameNewName: document.querySelector("#rename-new-name"),
  renameNewNameError: document.querySelector("#rename-new-name-error"),
  renameSubmit: document.querySelector("#rename-key"),
  retryUnlock: document.querySelector("#retry-unlock"),
  saveKey: document.querySelector("#save-key"),
  securityButton: document.querySelector("#security-details"),
  securityDialog: document.querySelector("#security-dialog"),
  status: document.querySelector("#vault-status"),
  template: document.querySelector("#key-row-template"),
  themeToggle: document.querySelector("#theme-toggle"),
  toastRegion: document.querySelector("#toast-region"),
  unlockError: document.querySelector("#unlock-error"),
  unlockVault: document.querySelector("#unlock-vault"),
  valueVisibility: document.querySelector("#value-visibility"),
};

class ApiError extends Error {
  constructor(message, field, status) {
    super(message);
    this.field = field;
    this.status = status;
  }
}

async function api(path, payload = {}) {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Session": sessionToken,
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(result.error ?? "The local vault action did not complete.", result.field, response.status);
  }
  return result;
}

function setHidden(element, hidden) {
  element.hidden = hidden;
}

function setButtonLoading(button, loading, loadingLabel) {
  button.disabled = loading;
  button.setAttribute("aria-busy", String(loading));
  const label = button.querySelector(".button-label");
  if (label) {
    if (!label.dataset.idleLabel) label.dataset.idleLabel = label.textContent;
    label.textContent = loading ? loadingLabel : label.dataset.idleLabel;
  }
}

function updateStatus() {
  const label = elements.status.querySelector("span");
  elements.status.classList.toggle("vault-status-locked", !state.unlocked);
  elements.status.classList.toggle("vault-status-unlocked", state.unlocked);
  elements.status.disabled = !state.unlocked;
  elements.status.setAttribute("aria-label", state.unlocked ? "Lock vault" : "Vault locked");
  label.textContent = state.unlocked ? "Lock vault" : "Locked";
}

function clearRevealedValue() {
  state.revealedName = "";
  state.revealedValue = "";
  state.revealLoadingName = "";
  state.revealErrorName = "";
  state.revealError = "";
}

function applyLocalLock() {
  clearRevealedValue();
  state.copyLoadingName = "";
  state.unlocked = false;
  state.loading = false;
  state.names = [];
  state.selectedName = "";
  closeDialog(elements.keyDialog);
  closeDialog(elements.renameDialog);
  closeDialog(elements.deleteDialog);
  render();
}

function currentNames() {
  const query = state.query.trim().toLocaleUpperCase();
  if (!query) return state.names;
  return state.names.filter((name) => name.toLocaleUpperCase().includes(query));
}

function syncSearchUrl() {
  const url = new URL(window.location.href);
  if (state.query) url.searchParams.set("q", state.query);
  else url.searchParams.delete("q");
  window.history.replaceState(null, "", url);
}

function renderList() {
  const names = currentNames();
  elements.keyList.replaceChildren();

  for (const name of names) {
    const row = elements.template.content.cloneNode(true);
    const item = row.querySelector(".key-row");
    const nameElement = row.querySelector(".key-name");
    const revealButton = row.querySelector(".key-reveal");
    const valueElement = row.querySelector(".masked-value");
    const copyButton = row.querySelector(".copy-key");
    const renameButton = row.querySelector(".rename-key");
    const replaceButton = row.querySelector(".replace-key");
    const deleteButton = row.querySelector(".remove-key");

    nameElement.textContent = name;
    nameElement.title = name;
    revealButton.setAttribute("aria-label", `Reveal value for ${name}`);
    revealButton.setAttribute("aria-pressed", "false");
    copyButton.setAttribute("aria-label", `Copy value for ${name}`);

    if (state.copyLoadingName === name) {
      copyButton.disabled = true;
      copyButton.setAttribute("aria-busy", "true");
      copyButton.querySelector("span").textContent = "Copying…";
      revealButton.disabled = true;
    }

    if (state.revealedName === name) {
      valueElement.textContent = state.revealedValue;
      valueElement.classList.add("revealed-value");
      revealButton.setAttribute("aria-label", `Hide value for ${name}`);
      revealButton.setAttribute("aria-pressed", "true");
      item.classList.add("key-row-revealed");
    } else if (state.revealLoadingName === name) {
      valueElement.textContent = "Loading…";
      valueElement.classList.add("revealed-value");
      revealButton.disabled = true;
      revealButton.setAttribute("aria-busy", "true");
    } else if (state.revealErrorName === name) {
      valueElement.textContent = state.revealError;
      valueElement.classList.add("reveal-error");
      revealButton.setAttribute("aria-label", `Retry revealing value for ${name}`);
    } else {
      valueElement.textContent = "•••••••• · Reveal";
    }

    renameButton.setAttribute("aria-label", `Rename ${name}`);
    replaceButton.setAttribute("aria-label", `Replace ${name}`);
    deleteButton.setAttribute("aria-label", `Delete ${name}`);
    revealButton.addEventListener("click", () => toggleReveal(name));
    copyButton.addEventListener("click", () => copyValue(name));
    renameButton.addEventListener("click", () => openRenameDialog(name));
    replaceButton.addEventListener("click", () => openKeyDialog("replace", name));
    deleteButton.addEventListener("click", () => openDeleteDialog(name));
    item.dataset.name = name;
    elements.keyList.append(row);
  }

  elements.count.textContent = String(state.names.length);
  elements.keySearch.disabled = !state.unlocked;
  elements.addKey.disabled = !state.unlocked;

  const showEmpty = state.unlocked && !state.loading && names.length === 0;
  if (showEmpty && state.names.length > 0) {
    elements.emptyTitle.textContent = "No matching keys";
    elements.emptyCopy.textContent = `Nothing matches “${state.query}”. Try another name.`;
    elements.emptyAction.textContent = "Clear search";
  } else {
    elements.emptyTitle.textContent = "No keys yet";
    elements.emptyCopy.textContent = "Add the first variable to your protected source vault.";
    elements.emptyAction.textContent = "Add a key";
  }

  setHidden(elements.emptyState, !showEmpty);
  setHidden(elements.keyList, !state.unlocked || state.loading || showEmpty);
}

async function copyValue(name) {
  if (state.copyLoadingName) return;

  state.copyLoadingName = name;
  renderList();

  try {
    await api("/api/keys/copy", { name });
    showToast(`${name} copied to clipboard`);
  } catch (error) {
    if (error.status === 423) {
      applyLocalLock();
      showToast("Vault locked. Unlock it again.");
      return;
    }
    showToast(error.message ?? "The value could not be copied.");
  } finally {
    state.copyLoadingName = "";
    renderList();
  }
}

async function toggleReveal(name) {
  if (state.revealedName === name) {
    clearRevealedValue();
    renderList();
    return;
  }

  clearRevealedValue();
  state.revealLoadingName = name;
  renderList();

  try {
    const result = await api("/api/keys/reveal", { name });
    state.revealedName = name;
    state.revealedValue = result.value;
  } catch (error) {
    if (error.status === 423) {
      applyLocalLock();
      showToast("Vault locked. Unlock it again.");
      return;
    }
    state.revealErrorName = name;
    state.revealError = error.message;
  } finally {
    state.revealLoadingName = "";
    renderList();
  }
}

function render() {
  updateStatus();
  setHidden(elements.lockedState, state.unlocked || state.loading);
  setHidden(elements.loadingState, !state.loading);
  if (state.loading) setHidden(elements.errorState, true);
  renderList();
}

function showUnlockError(message) {
  clearRevealedValue();
  state.loading = false;
  state.unlocked = false;
  state.names = [];
  elements.unlockError.textContent = message;
  setHidden(elements.errorState, false);
  setHidden(elements.lockedState, true);
  setHidden(elements.loadingState, true);
  updateStatus();
}

async function unlockVault() {
  clearRevealedValue();
  state.loading = true;
  setHidden(elements.errorState, true);
  elements.unlockVault.disabled = true;
  render();

  try {
    const result = await api("/api/unlock");
    state.names = [...new Set(result.names)].sort((left, right) => left.localeCompare(right));
    state.unlocked = true;
    state.loading = false;
    render();
    showToast(`Vault unlocked · ${state.names.length} ${state.names.length === 1 ? "key" : "keys"}`);
  } catch (error) {
    showUnlockError(error.message);
  } finally {
    elements.unlockVault.disabled = false;
  }
}

async function lockVault() {
  if (!state.unlocked) return;
  elements.status.disabled = true;

  try {
    await api("/api/lock");
    applyLocalLock();
    showToast("Vault locked");
  } catch (error) {
    updateStatus();
    showToast(error.message);
  }
}

function resetFieldError(input, errorElement, hintId = "") {
  input.removeAttribute("aria-invalid");
  if (hintId) input.setAttribute("aria-describedby", hintId);
  else input.removeAttribute("aria-describedby");
  errorElement.textContent = "";
  errorElement.hidden = true;
}

function setFieldError(input, errorElement, message) {
  input.setAttribute("aria-invalid", "true");
  input.setAttribute("aria-describedby", errorElement.id);
  errorElement.textContent = message;
  errorElement.hidden = false;
}

function clearKeyFormErrors() {
  elements.keyFormError.hidden = true;
  elements.keyFormError.textContent = "";
  resetFieldError(elements.keyName, elements.keyNameError, "key-name-hint");
  resetFieldError(elements.keyValue, elements.keyValueError, "value-hint");
  resetFieldError(elements.keyConfirmValue, elements.keyConfirmValueError);
}

function clearDeleteFormErrors() {
  elements.deleteFormError.hidden = true;
  elements.deleteFormError.textContent = "";
  resetFieldError(elements.deleteConfirmation, elements.deleteConfirmationError);
}

function clearRenameFormErrors() {
  elements.renameFormError.hidden = true;
  elements.renameFormError.textContent = "";
  resetFieldError(elements.renameNewName, elements.renameNewNameError, "rename-new-name-hint");
}

function setVisibility(visible) {
  elements.keyValue.type = visible ? "text" : "password";
  elements.keyConfirmValue.type = visible ? "text" : "password";
  elements.valueVisibility.dataset.visible = String(visible);
  elements.valueVisibility.setAttribute("aria-label", visible ? "Hide secret values" : "Show secret values");
}

function openKeyDialog(mode, name = "") {
  state.dialogMode = mode;
  state.selectedName = name;
  elements.keyForm.reset();
  clearKeyFormErrors();
  setVisibility(false);

  const replacing = mode === "replace";
  elements.keyName.value = name;
  elements.keyName.readOnly = replacing;
  elements.keyNameHint.textContent = replacing
    ? "Use Rename from the key row to change this name."
    : "Use letters, numbers, and underscores. Start with a letter or underscore.";
  elements.keyDialogEyebrow.textContent = replacing ? "Existing variable" : "New variable";
  elements.keyDialogTitle.textContent = replacing ? "Replace key value" : "Add a key";
  elements.keyDialogCopy.textContent = replacing
    ? "The current value stays hidden and will be replaced in full."
    : "Store a new value in the protected source vault.";
  elements.saveKey.querySelector(".button-label").textContent = replacing ? "Replace value" : "Add key";
  delete elements.saveKey.querySelector(".button-label").dataset.idleLabel;
  elements.keyDialog.showModal();
  window.setTimeout(() => (replacing ? elements.keyValue : elements.keyName).focus(), 0);
}

function openRenameDialog(name) {
  state.selectedName = name;
  elements.renameForm.reset();
  clearRenameFormErrors();
  elements.renameCurrentName.value = name;
  elements.renameNewName.value = name;
  elements.renameDialog.showModal();
  window.setTimeout(() => {
    elements.renameNewName.focus();
    elements.renameNewName.select();
  }, 0);
}

function openDeleteDialog(name) {
  state.selectedName = name;
  elements.deleteForm.reset();
  clearDeleteFormErrors();
  elements.deleteKeyName.textContent = name;
  elements.deleteCopy.textContent =
    state.names.length === 1
      ? "This is the last key. Deleting it also removes the empty vault item."
      : "This permanently removes the value from the source vault.";
  elements.deleteDialog.showModal();
  window.setTimeout(() => elements.deleteConfirmation.focus(), 0);
}

function closeDialog(dialog) {
  if (dialog.open) dialog.close();
  elements.keyValue.value = "";
  elements.keyConfirmValue.value = "";
  elements.renameCurrentName.value = "";
  elements.renameNewName.value = "";
  elements.deleteConfirmation.value = "";
  setVisibility(false);
}

function validateRenameForm() {
  clearRenameFormErrors();
  const newName = elements.renameNewName.value.trim();
  const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!namePattern.test(newName)) {
    setFieldError(
      elements.renameNewName,
      elements.renameNewNameError,
      "Start with a letter or underscore; use only letters, numbers, and underscores.",
    );
  } else if (newName === state.selectedName) {
    setFieldError(elements.renameNewName, elements.renameNewNameError, "Choose a different variable name.");
  } else if (state.names.includes(newName)) {
    setFieldError(elements.renameNewName, elements.renameNewNameError, `${newName} already exists.`);
  } else {
    return true;
  }
  elements.renameNewName.focus();
  return false;
}

function validateKeyForm() {
  clearKeyFormErrors();
  const name = elements.keyName.value.trim();
  const namePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!namePattern.test(name)) {
    setFieldError(
      elements.keyName,
      elements.keyNameError,
      "Start with a letter or underscore; use only letters, numbers, and underscores.",
    );
    elements.keyName.focus();
    return false;
  }
  if (!elements.keyValue.value) {
    setFieldError(elements.keyValue, elements.keyValueError, "Enter a secret value.");
    elements.keyValue.focus();
    return false;
  }
  if (/[\0\r\n]/.test(elements.keyValue.value)) {
    setFieldError(elements.keyValue, elements.keyValueError, "Secret values must fit on one line.");
    elements.keyValue.focus();
    return false;
  }
  if (elements.keyValue.value !== elements.keyConfirmValue.value) {
    setFieldError(elements.keyConfirmValue, elements.keyConfirmValueError, "The two values do not match.");
    elements.keyConfirmValue.focus();
    return false;
  }
  return true;
}

function showKeyApiError(error) {
  if (error.field === "name") {
    setFieldError(elements.keyName, elements.keyNameError, error.message);
    elements.keyName.focus();
    return;
  }
  if (error.field === "value") {
    setFieldError(elements.keyValue, elements.keyValueError, error.message);
    elements.keyValue.focus();
    return;
  }
  if (error.field === "confirmValue") {
    setFieldError(elements.keyConfirmValue, elements.keyConfirmValueError, error.message);
    elements.keyConfirmValue.focus();
    return;
  }
  elements.keyFormError.textContent = error.message;
  elements.keyFormError.hidden = false;
}

async function submitKeyForm(event) {
  event.preventDefault();
  if (!validateKeyForm()) return;

  const action = state.dialogMode;
  const name = elements.keyName.value.trim();
  setButtonLoading(elements.saveKey, true, action === "create" ? "Adding…" : "Replacing…");

  try {
    await api(`/api/keys/${action}`, {
      name,
      value: elements.keyValue.value,
      confirmValue: elements.keyConfirmValue.value,
    });
    if (action === "create") {
      state.names = [...state.names, name].sort((left, right) => left.localeCompare(right));
    }
    if (state.revealedName === name) clearRevealedValue();
    closeDialog(elements.keyDialog);
    render();
    showToast(action === "create" ? `${name} added` : `${name} replaced`);
  } catch (error) {
    showKeyApiError(error);
  } finally {
    elements.keyValue.value = "";
    elements.keyConfirmValue.value = "";
    setButtonLoading(elements.saveKey, false, "");
  }
}

async function submitDeleteForm(event) {
  event.preventDefault();
  clearDeleteFormErrors();

  if (elements.deleteConfirmation.value !== state.selectedName) {
    setFieldError(
      elements.deleteConfirmation,
      elements.deleteConfirmationError,
      "Type the variable name exactly to confirm deletion.",
    );
    elements.deleteConfirmation.focus();
    return;
  }

  setButtonLoading(elements.deleteSubmit, true, "Deleting…");
  try {
    await api("/api/keys/delete", {
      name: state.selectedName,
      confirmName: elements.deleteConfirmation.value,
    });
    const deletedName = state.selectedName;
    state.names = state.names.filter((name) => name !== deletedName);
    if (state.revealedName === deletedName) clearRevealedValue();
    closeDialog(elements.deleteDialog);
    render();
    showToast(`${deletedName} deleted`);
  } catch (error) {
    if (error.field === "confirmName") {
      setFieldError(elements.deleteConfirmation, elements.deleteConfirmationError, error.message);
      elements.deleteConfirmation.focus();
    } else {
      elements.deleteFormError.textContent = error.message;
      elements.deleteFormError.hidden = false;
    }
  } finally {
    setButtonLoading(elements.deleteSubmit, false, "");
  }
}

async function submitRenameForm(event) {
  event.preventDefault();
  if (!validateRenameForm()) return;

  const currentName = state.selectedName;
  const newName = elements.renameNewName.value.trim();
  setButtonLoading(elements.renameSubmit, true, "Renaming…");
  try {
    await api("/api/keys/rename", { name: currentName, newName });
    state.names = state.names
      .map((name) => (name === currentName ? newName : name))
      .sort((left, right) => left.localeCompare(right));
    if (state.revealedName === currentName) clearRevealedValue();
    closeDialog(elements.renameDialog);
    render();
    showToast(`${currentName} renamed to ${newName}`);
  } catch (error) {
    if (error.field === "newName") {
      setFieldError(elements.renameNewName, elements.renameNewNameError, error.message);
      elements.renameNewName.focus();
    } else {
      elements.renameFormError.textContent = error.message;
      elements.renameFormError.hidden = false;
    }
  } finally {
    setButtonLoading(elements.renameSubmit, false, "");
  }
}

function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.innerHTML = `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m20 6-11 11-5-5"></path>
    </svg>
    <p></p>
    <button class="icon-button" type="button" aria-label="Dismiss notification">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"></path></svg>
    </button>
  `;
  toast.querySelector("p").textContent = message;
  const dismiss = () => toast.remove();
  toast.querySelector("button").addEventListener("click", dismiss);
  elements.toastRegion.replaceChildren(toast);
  window.setTimeout(dismiss, 5000);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  elements.themeToggle.setAttribute("aria-label", theme === "dark" ? "Use light theme" : "Use dark theme");
}

function initializeTheme() {
  const storedTheme = window.localStorage.getItem("vault-theme");
  const preferredTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : preferredTheme);
}

elements.unlockVault.addEventListener("click", unlockVault);
elements.retryUnlock.addEventListener("click", unlockVault);
elements.status.addEventListener("click", lockVault);
elements.securityButton.addEventListener("click", () => elements.securityDialog.showModal());
elements.addKey.addEventListener("click", () => openKeyDialog("create"));
elements.emptyAction.addEventListener("click", () => {
  if (state.names.length > 0) {
    state.query = "";
    elements.keySearch.value = "";
    syncSearchUrl();
    render();
  } else {
    openKeyDialog("create");
  }
});
elements.keySearch.addEventListener("input", (event) => {
  clearRevealedValue();
  state.query = event.currentTarget.value;
  syncSearchUrl();
  renderList();
});
elements.keyForm.addEventListener("submit", submitKeyForm);
elements.renameForm.addEventListener("submit", submitRenameForm);
elements.deleteForm.addEventListener("submit", submitDeleteForm);
elements.valueVisibility.addEventListener("click", () => {
  setVisibility(elements.valueVisibility.dataset.visible !== "true");
});
elements.themeToggle.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  window.localStorage.setItem("vault-theme", theme);
  applyTheme(theme);
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => closeDialog(document.querySelector(`#${button.dataset.close}`)));
});
for (const dialog of [elements.securityDialog, elements.keyDialog, elements.renameDialog, elements.deleteDialog]) {
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
}
elements.keyDialog.addEventListener("close", () => {
  elements.keyValue.value = "";
  elements.keyConfirmValue.value = "";
  setVisibility(false);
});
elements.renameDialog.addEventListener("close", () => {
  elements.renameCurrentName.value = "";
  elements.renameNewName.value = "";
});
elements.deleteDialog.addEventListener("close", () => {
  elements.deleteConfirmation.value = "";
});
window.addEventListener("beforeunload", () => {
  clearRevealedValue();
  elements.keyValue.value = "";
  elements.keyConfirmValue.value = "";
  elements.renameCurrentName.value = "";
  elements.renameNewName.value = "";
  elements.deleteConfirmation.value = "";
});
window.addEventListener("pagehide", () => {
  if (!state.unlocked) return;
  clearRevealedValue();
  state.unlocked = false;
  fetch("/api/lock", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    keepalive: true,
    headers: {
      "Content-Type": "application/json",
      "X-Vault-Session": sessionToken,
    },
    body: "{}",
  }).catch(() => {});
});

initializeTheme();
elements.keySearch.value = state.query;
render();
