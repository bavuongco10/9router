"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";

// Paste a connection blob copied (via the Copy button) from another 9router.
// Posts to /api/providers/import which recreates it through the WAL-safe
// createProviderConnection path.
export default function ImportConnectionModal({ isOpen, onClose, onSuccess }) {
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(null);

  const handleClose = () => {
    if (submitting) return;
    setJsonText("");
    setError("");
    setDone(null);
    onClose();
  };

  const handleSubmit = async () => {
    setError("");
    setDone(null);
    const trimmed = jsonText.trim();
    if (!trimmed) return;

    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      setError(`Invalid JSON: ${err.message}`);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/providers/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection: parsed }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      setDone(data.connection);
      if (typeof onSuccess === "function") onSuccess();
    } catch (err) {
      setError(err.message || "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} title="Import Connection" onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          Paste connection JSON copied from another 9router (the Copy button on a connection).
          Tokens are included, so it activates immediately.
        </p>

        <textarea
          className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[240px] focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder={'{\n  "provider": "claude",\n  "authType": "oauth",\n  "refreshToken": "..."\n}'}
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
          disabled={submitting}
        />

        {error && <p className="text-xs text-red-500 break-words">{error}</p>}

        {done && (
          <div className="text-sm font-medium text-green-400">
            ✓ Imported {done.provider} connection{done.name ? ` (${done.name})` : ""}
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={handleSubmit} fullWidth disabled={submitting || !jsonText.trim()}>
            {submitting ? "Importing..." : "Import"}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

ImportConnectionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
