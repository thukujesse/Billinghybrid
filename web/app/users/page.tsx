import { redirect } from 'next/navigation';

// /users isn't a destination of its own — bounce to the Hotspot tab by
// default since that's what operators check most often.
export default function UsersIndex() {
  redirect('/users/hotspot');
}