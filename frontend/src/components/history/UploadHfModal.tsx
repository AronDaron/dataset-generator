'use client'

import { useState } from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { X, CheckCircle2, AlertCircle, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { uploadToHuggingFace } from '@/lib/api'
import { cn } from '@/lib/utils'

type ModalState = 'form' | 'uploading' | 'success' | 'error'

interface UploadHfModalProps {
  open: boolean
  onClose: () => void
  jobId: string
  hasHfToken: boolean
}

export function UploadHfModal({ open, onClose, jobId, hasHfToken }: UploadHfModalProps) {
  const [state, setState] = useState<ModalState>('form')
  const [repoName, setRepoName] = useState('')
  const [isPrivate, setIsPrivate] = useState(true)
  const [resultUrl, setResultUrl] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  function handleClose() {
    onClose()
    // Reset state after close animation
    setTimeout(() => {
      setState('form')
      setRepoName('')
      setIsPrivate(true)
      setResultUrl('')
      setErrorMessage('')
    }, 200)
  }

  async function handleUpload() {
    if (!repoName.trim()) return
    setState('uploading')
    try {
      const result = await uploadToHuggingFace(jobId, {
        repo_name: repoName.trim(),
        private: isPrivate,
      })
      setResultUrl(result.url)
      setState('success')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed')
      setState('error')
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[4px]" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-xl border border-border bg-card shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7),0_8px_20px_rgba(0,0,0,0.35)]',
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-6 py-4">
            <Dialog.Title className="font-serif text-xl italic tracking-[-0.01em] text-text-0">
              Upload to HuggingFace
            </Dialog.Title>
            <Dialog.Close
              render={
                <Button variant="ghost" size="icon" onClick={handleClose}>
                  <X className="size-4" />
                </Button>
              }
            />
          </div>

          {/* Content */}
          <div className="px-6 py-5">
            {/* No token state */}
            {!hasHfToken && (
              <div className="space-y-4 py-4 text-center">
                <AlertCircle className="mx-auto size-10 text-text-3" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-text-0">HuggingFace token not configured</p>
                  <p className="text-xs text-text-3">
                    Add your HuggingFace token in Settings (API Keys tab) before uploading.
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={handleClose}>
                  Close
                </Button>
              </div>
            )}

            {/* Form state */}
            {hasHfToken && state === 'form' && (
              <div className="space-y-5">
                <div className="space-y-1.5">
                  <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">Repository name</label>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpload()}
                    placeholder="username/my-dataset"
                    autoFocus
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-0 outline-none placeholder:text-text-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                  />
                  <p className="text-xs text-text-3">
                    Format: your-username/dataset-name
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-medium uppercase tracking-widest text-text-3">Visibility</label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setIsPrivate(true)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        isPrivate
                          ? 'border-transparent bg-accent-soft text-primary'
                          : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                      )}
                    >
                      Private
                    </button>
                    <button
                      onClick={() => setIsPrivate(false)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        !isPrivate
                          ? 'border-transparent bg-accent-soft text-primary'
                          : 'border-border bg-card text-text-2 hover:border-line-strong hover:bg-muted hover:text-text-0',
                      )}
                    >
                      Public
                    </button>
                  </div>
                  <p className="text-xs text-text-3">
                    {isPrivate
                      ? 'Only you can see this dataset.'
                      : 'Anyone can see and download this dataset.'}
                  </p>
                </div>
              </div>
            )}

            {/* Uploading state */}
            {hasHfToken && state === 'uploading' && (
              <div className="flex flex-col items-center gap-3 py-8">
                <Loader2 className="size-8 animate-spin text-primary" />
                <p className="text-sm text-text-3">
                  Uploading to <span className="font-mono text-text-1">{repoName}</span>...
                </p>
              </div>
            )}

            {/* Success state */}
            {hasHfToken && state === 'success' && (
              <div className="flex flex-col items-center gap-4 py-6">
                <CheckCircle2 className="size-10 text-ok" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-ok">Successfully uploaded!</p>
                  <p className="break-all font-mono text-xs text-text-3">{resultUrl}</p>
                </div>
                <a href={resultUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="gap-1.5">
                    <ExternalLink className="size-3.5" />
                    Open in browser
                  </Button>
                </a>
              </div>
            )}

            {/* Error state */}
            {hasHfToken && state === 'error' && (
              <div className="flex flex-col items-center gap-4 py-6">
                <AlertCircle className="size-10 text-destructive" />
                <div className="space-y-1 text-center">
                  <p className="text-sm font-medium text-destructive">Upload failed</p>
                  <p className="max-w-[300px] text-xs text-text-3">{errorMessage}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          {hasHfToken && (
            <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-4">
              {state === 'form' && (
                <>
                  <Button variant="ghost" onClick={handleClose}>Cancel</Button>
                  <Button onClick={handleUpload} disabled={!repoName.trim()}>Upload</Button>
                </>
              )}
              {state === 'success' && (
                <Button variant="ghost" onClick={handleClose}>Close</Button>
              )}
              {state === 'error' && (
                <>
                  <Button variant="ghost" onClick={handleClose}>Close</Button>
                  <Button onClick={() => setState('form')}>Try again</Button>
                </>
              )}
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
