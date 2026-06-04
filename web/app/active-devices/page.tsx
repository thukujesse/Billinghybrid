import { redirect } from 'next/navigation';

// Legacy path — the Hotspot device view now lives under /users/hotspot.
// Bookmarks and any external links keep working.
export default function ActiveDevicesRedirect() {
  redirect('/users/hotspot');
}