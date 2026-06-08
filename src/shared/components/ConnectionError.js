"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import Modal from "./Modal";
import Button from "./Button";

// Inline truncated error text that opens a modal with the full, copyable message.
export default function ConnectionError({ error, errorType, errorAt }) {
  const [showModal, setShowModal] = useState(false);
  const [copied, setCopied] = useState(false);

  if (!error) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(error);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback for browsers/contexts without clipboard API
      const ta = document.createElement("textarea");
      ta.value = error;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* noop */ }
      document.body.removeChild(ta);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setShowModal(true)}
        title="Click to view full error"
        className="text-xs text-red-500 truncate max-w-full sm:max-w-[300px] underline decoration-dotted underline-offset-2 hover:text-red-400 cursor-pointer text-left"
      >
        {error}
      </button>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Connection Error" size="full">
        <div className="flex flex-col gap-3">
          {(errorType || errorAt) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
              {errorType && <span>Type: <span className="font-mono text-text-main">{errorType}</span></span>}
              {errorAt && <span>At: <span className="font-mono text-text-main">{new Date(errorAt).toLocaleString()}</span></span>}
            </div>
          )}
          <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/5 dark:bg-white/5 p-3 text-xs font-mono text-red-500 custom-scrollbar select-text">
            {error}
          </pre>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={handleCopy}>
              <span className="material-symbols-outlined text-[16px] mr-1">{copied ? "check" : "content_copy"}</span>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

ConnectionError.propTypes = {
  error: PropTypes.string,
  errorType: PropTypes.string,
  errorAt: PropTypes.oneOfType([PropTypes.string, PropTypes.number]),
};
