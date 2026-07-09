import {
  isAdminDocumentVisible,
  isAdminTabLiveActive,
  subscribeAdminTabLiveActive,
} from '@/lib/adminTabLeader';

/** True when this admin tab should run polls or live listeners for a page. */
export function isAdminPageLiveActive(): boolean {
  return isAdminTabLiveActive() && isAdminDocumentVisible();
}

export function subscribeAdminPageLiveActive(listener: (active: boolean) => void): () => void {
  return subscribeAdminTabLiveActive((leader) => {
    listener(leader && isAdminDocumentVisible());
  });
}
