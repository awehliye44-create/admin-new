import { mapboxgl } from '@/lib/mapbox';

export interface AdminMapToolbarOptions {
  onFit?: () => void;
  onRecenter?: () => void;
  fitTitle?: string;
  recenterTitle?: string;
  position?: 'top-right' | 'top-left';
}

function makeToolbarButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mapboxgl-ctrl-icon';
  button.title = title;
  button.setAttribute('aria-label', title);
  button.textContent = label;
  button.style.fontSize = '13px';
  button.style.fontWeight = '600';
  button.style.lineHeight = '29px';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

class AdminMapToolbarControl implements mapboxgl.IControl {
  private container?: HTMLDivElement;
  private readonly options: AdminMapToolbarOptions;

  constructor(options: AdminMapToolbarOptions) {
    this.options = options;
  }

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'mapboxgl-ctrl mapboxgl-ctrl-group';

    if (this.options.onFit) {
      container.appendChild(
        makeToolbarButton('⊞', this.options.fitTitle ?? 'Fit to view', this.options.onFit),
      );
    }
    if (this.options.onRecenter) {
      container.appendChild(
        makeToolbarButton('◎', this.options.recenterTitle ?? 'Recenter', this.options.onRecenter),
      );
    }

    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = undefined;
  }
}

/**
 * Standard admin map controls: zoom +/-, scroll zoom, pan, fullscreen, optional fit/recenter.
 */
export function attachAdminMapControls(
  map: mapboxgl.Map,
  options: AdminMapToolbarOptions = {},
): () => void {
  const position = options.position ?? 'top-right';
  const nav = new mapboxgl.NavigationControl({ showCompass: false, visualizePitch: false });
  const fullscreen = new mapboxgl.FullscreenControl();
  const toolbar = new AdminMapToolbarControl(options);

  map.addControl(nav, position);
  map.addControl(fullscreen, position);
  if (options.onFit || options.onRecenter) {
    map.addControl(toolbar, position);
  }

  map.scrollZoom.enable();
  map.dragPan.enable();
  map.doubleClickZoom.enable();
  map.touchZoomRotate.enable();

  return () => {
    try {
      map.removeControl(nav);
      map.removeControl(fullscreen);
      if (options.onFit || options.onRecenter) map.removeControl(toolbar);
    } catch {
      /* map may already be removed */
    }
  };
}
