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
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" />
        <Dialog.Popup
          className={cn(
            'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
            'rounded-2xl shadow-2xl',
            'ring-1 ring-white/10',
          )}
          style={{
            background: 'oklch(0.13 0.026 232 / 0.97)',
            backdropFilter: 'blur(20px)',
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/8 px-6 py-4">
            <Dialog.Title className="text-base font-semibold">
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
              <div className="space-y-4 text-center py-4">
                <AlertCircle className="size-10 text-muted-foreground mx-auto" />
                <div className="space-y-1">
                  <p className="text-sm font-medium">HuggingFace token not configured</p>
                  <p className="text-xs text-muted-foreground">
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
                  <label className="text-sm font-medium">Repository name</label>
                  <input
                    type="text"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpload()}
                    placeholder="username/my-dataset"
                    autoFocus
                    className="w-full rounded-lg border border-border bg-white/4 px-3 py-2 text-sm outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20"
                  />
                  <p className="text-xs text-muted-foreground">
                    Format: your-username/dataset-name
                  </p>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Visibility</label>
                  <div className="flex gap-3">
                    <button
                      onClick={() => setIsPrivate(true)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        isPrivate
                          ? 'border-primary/50 bg-primary/15 text-primary'
                          : 'border-white/8 bg-white/3 text-muted-foreground hover:border-white/15',
                      )}
                    >
                      Private
                    </button>
                    <button
                      onClick={() => setIsPrivate(false)}
                      className={cn(
                        'flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-colors',
                        !isPrivate
                          ? 'border-primary/50 bg-primary/15 text-primary'
                          : 'border-white/8 bg-white/3 text-muted-foreground hover:border-white/15',
                      )}
                    >
                      Public
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
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
                <Loader2 className="size-8 text-primary animate-spin" />
                <p className="text-sm text-muted-foreground">
                  Uploading to <span className="font-mono text-foreground">{repoName}</span>...
                </p>
              </div>
            )}

            {/* Success state */}
            {hasHfToken && state === 'success' && (
              <div className="flex flex-col items-center gap-4 py-6">
                <CheckCircle2 className="size-10 text-emerald-400" />
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-emerald-400">Successfully uploaded!</p>
                  <p className="font-mono text-xs text-muted-foreground break-all">{resultUrl}</p>
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
                <div className="text-center space-y-1">
                  <p className="text-sm font-medium text-destructive">Upload failed</p>
                  <p className="text-xs text-muted-foreground max-w-[300px]">{errorMessage}</p>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          {hasHfToken && (
            <div className="flex items-center justify-end gap-2 border-t border-white/8 px-6 py-4">
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
