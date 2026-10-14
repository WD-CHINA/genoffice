export const defaultViewerUi = {
  showHeader: true,
  showImport: true,
  showUrlImport: true,
  showToolbar: true,
  showErrors: true,
  showSidebar: true,
}

export type ViewerUi = typeof defaultViewerUi

function booleanParam(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return fallback
}

export function readViewerUi(params: URLSearchParams): ViewerUi {
  const fallback = !booleanParam(params.get('embed'), false)
  return Object.fromEntries(
    Object.keys(defaultViewerUi).map((key) => [key, booleanParam(params.get(key), fallback)]),
  ) as ViewerUi
}

export function viewerUiParams(ui: ViewerUi): Record<string, string> {
  return Object.fromEntries(Object.entries(ui).map(([key, visible]) => [key, visible ? '1' : '0']))
}

export function applyViewerUi(ui: ViewerUi): void {
  const data = document.documentElement.dataset
  data.viewerToolbar = String(ui.showToolbar)
  data.viewerErrors = String(ui.showErrors)
  data.viewerSidebar = String(ui.showSidebar)
}
