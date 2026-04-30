import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  limit,
  query,
} from "firebase/firestore";
import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[firebase-test] Missing ${name} environment variable.`);
  }
  return value;
}

function getFirebaseConfig() {
  return {
    apiKey: requireEnv("REACT_APP_FIREBASE_API_KEY"),
    authDomain: requireEnv("REACT_APP_FIREBASE_AUTH_DOMAIN"),
    projectId: requireEnv("REACT_APP_FIREBASE_PROJECT_ID"),
    storageBucket: requireEnv("REACT_APP_FIREBASE_STORAGE_BUCKET"),
    messagingSenderId: requireEnv("REACT_APP_FIREBASE_MESSAGING_SENDER_ID"),
    appId: requireEnv("REACT_APP_FIREBASE_APP_ID"),
  };
}

async function main(): Promise<void> {
  const app = getApps().length > 0 ? getApp() : initializeApp(getFirebaseConfig());
  const db = getFirestore(app);
  const auth = getAuth(app);
  const userId = requireEnv("FIREBASE_USER_ID").trim();

  if (!userId) {
    throw new Error("[firebase-test] FIREBASE_USER_ID must not be empty.");
  }

  if (!auth.currentUser) {
    const email = requireEnv("FIREBASE_AUTH_EMAIL");
    const password = requireEnv("FIREBASE_AUTH_PASSWORD");
    await signInWithEmailAndPassword(auth, email, password);
  }

  if (!auth.currentUser) {
    throw new Error("[firebase-test] Sign-in failed: no current user.");
  }

  if (auth.currentUser.uid !== userId) {
    console.warn(
      `[firebase-test] Authenticated user ${auth.currentUser.uid} does not match FIREBASE_USER_ID ${userId}.`
    );
  }

  const userDocRef = doc(db, "users", userId);
  const userDocSnap = await getDoc(userDocRef);
  console.log(`[test] User doc exists: ${userDocSnap.exists()}`);

  for (const language of ["en", "id"] as const) {
    const subcollection = collection(db, "users", userId, language);
    const q = query(subcollection, limit(1));
    const snapshot = await getDocs(q);
    console.log(`[test] ${language} subcollection has docs: ${!snapshot.empty}`);
  }

  console.log("[test] Firestore read completed successfully.");
}

main().catch((error) => {
  console.error("[test] Firestore read failed:", error);
  process.exit(1);
});
