import { initializeApp, getApps } from 'firebase/app';
import {
  initializeFirestore,
  getFirestore,
  setLogLevel,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  deleteDoc,
  updateDoc,
} from 'firebase/firestore';
import fs from 'fs';
import path from 'path';
import type { User, StudentMaster } from '../../src/types/index.ts';

// Suppress benign internal gRPC idle stream cancellation notices
setLogLevel('silent');

// Load Firebase configuration
let firebaseConfig: any = {};
try {
  const configPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    firebaseConfig = JSON.parse(raw);
  }
} catch (e) {
  console.warn('Could not read firebase-applet-config.json:', e);
}

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const firestoreDb = initializeFirestore(
  app,
  { experimentalForceLongPolling: true },
  firebaseConfig.firestoreDatabaseId
);

// In-memory fallback / cache layer for quick access & resiliency
const memoryStore = {
  users: new Map<string, User>(),
  students: new Map<string, StudentMaster>(),
  initialized: false,
};

// Seed initial Admin: username: "admin", password: "admin"
export async function initializeDatabase() {
  if (memoryStore.initialized) return;

  const initialAdminId = 'user-admin-root';
  const defaultAdmin: User = {
    id: initialAdminId,
    username: 'admin',
    password: 'admin',
    role: 'admin',
    name: 'Administrator',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    const adminDocRef = doc(firestoreDb, 'users', initialAdminId);
    const snap = await getDoc(adminDocRef);
    if (!snap.exists()) {
      await setDoc(adminDocRef, defaultAdmin);
      console.log('Seeded initial admin into Firestore: admin / admin');
    }
  } catch (err) {
    console.warn('Firestore initial admin seed warning (using resilient memory backing):', err);
  }

  // Ensure default admin in memory
  if (!memoryStore.users.has(initialAdminId)) {
    memoryStore.users.set(initialAdminId, defaultAdmin);
  }

  // Pre-load users and students from Firestore if available
  try {
    const userDocs = await getDocs(collection(firestoreDb, 'users'));
    userDocs.forEach((d) => {
      const u = d.data() as User;
      memoryStore.users.set(u.id || d.id, { ...u, id: u.id || d.id });
    });

    const studentDocs = await getDocs(collection(firestoreDb, 'students'));
    studentDocs.forEach((d) => {
      const s = d.data() as StudentMaster;
      memoryStore.students.set(s.id || d.id, { ...s, id: s.id || d.id });
    });
  } catch (err) {
    console.warn('Note: Populating initial cache from Firestore:', err);
  }

  memoryStore.initialized = true;
}

// Live full re-sync from Firestore database
export async function syncDatabaseFromFirestore(): Promise<{
  success: boolean;
  timestamp: string;
  usersCount: number;
  studentsCount: number;
}> {
  await initializeDatabase();
  try {
    const userDocs = await getDocs(collection(firestoreDb, 'users'));
    memoryStore.users.clear();
    userDocs.forEach((d) => {
      const u = d.data() as User;
      memoryStore.users.set(u.id || d.id, { ...u, id: u.id || d.id });
    });

    const studentDocs = await getDocs(collection(firestoreDb, 'students'));
    memoryStore.students.clear();
    studentDocs.forEach((d) => {
      const s = d.data() as StudentMaster;
      memoryStore.students.set(s.id || d.id, { ...s, id: s.id || d.id });
    });

    // Ensure root admin is present
    const initialAdminId = 'user-admin-root';
    if (!memoryStore.users.has(initialAdminId)) {
      const defaultAdmin: User = {
        id: initialAdminId,
        username: 'admin',
        password: 'admin',
        role: 'admin',
        name: 'Administrator',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      memoryStore.users.set(initialAdminId, defaultAdmin);
    }

    console.log(`Synced with Firestore: ${memoryStore.users.size} users, ${memoryStore.students.size} students`);
    return {
      success: true,
      timestamp: new Date().toISOString(),
      usersCount: memoryStore.users.size,
      studentsCount: memoryStore.students.size,
    };
  } catch (err: any) {
    console.error('Error during Firestore sync:', err);
    return {
      success: false,
      timestamp: new Date().toISOString(),
      usersCount: memoryStore.users.size,
      studentsCount: memoryStore.students.size,
    };
  }
}

// User (Admin / Teacher) DAO
export async function getAllUsers(): Promise<User[]> {
  await initializeDatabase();
  try {
    const snap = await getDocs(collection(firestoreDb, 'users'));
    const list: User[] = [];
    snap.forEach((d) => {
      const data = d.data() as User;
      list.push({ ...data, id: d.id });
      memoryStore.users.set(d.id, { ...data, id: d.id });
    });
    if (list.length > 0) return list;
  } catch (e) {
    console.warn('Firestore getAllUsers fallback to cache');
  }
  return Array.from(memoryStore.users.values());
}

export async function getUserById(id: string): Promise<User | null> {
  await initializeDatabase();
  try {
    const snap = await getDoc(doc(firestoreDb, 'users', id));
    if (snap.exists()) {
      const data = snap.data() as User;
      return { ...data, id: snap.id };
    }
  } catch (e) {
    // fallback
  }
  return memoryStore.users.get(id) || null;
}

export async function getUserByUsername(username: string): Promise<User | null> {
  await initializeDatabase();
  const all = await getAllUsers();
  const match = all.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
  return match || null;
}

export async function saveUser(user: User): Promise<User> {
  await initializeDatabase();
  const now = new Date().toISOString();
  const toSave: User = {
    ...user,
    updatedAt: now,
    createdAt: user.createdAt || now,
  };

  memoryStore.users.set(toSave.id, toSave);

  try {
    await setDoc(doc(firestoreDb, 'users', toSave.id), toSave);
  } catch (err) {
    console.error('Error saving user to Firestore:', err);
  }
  return toSave;
}

export async function deleteUser(id: string): Promise<boolean> {
  await initializeDatabase();
  memoryStore.users.delete(id);
  try {
    await deleteDoc(doc(firestoreDb, 'users', id));
    return true;
  } catch (err) {
    console.error('Error deleting user from Firestore:', err);
    return true;
  }
}

// Student Master DAO
export async function getAllStudents(): Promise<StudentMaster[]> {
  await initializeDatabase();
  try {
    const snap = await getDocs(collection(firestoreDb, 'students'));
    const list: StudentMaster[] = [];
    snap.forEach((d) => {
      const data = d.data() as StudentMaster;
      list.push({ ...data, id: d.id });
      memoryStore.students.set(d.id, { ...data, id: d.id });
    });
    if (list.length > 0) return list;
  } catch (e) {
    console.warn('Firestore getAllStudents fallback to cache');
  }
  return Array.from(memoryStore.students.values());
}

export async function getStudentById(id: string): Promise<StudentMaster | null> {
  await initializeDatabase();
  try {
    const snap = await getDoc(doc(firestoreDb, 'students', id));
    if (snap.exists()) {
      const data = snap.data() as StudentMaster;
      return { ...data, id: snap.id };
    }
  } catch (e) {}
  return memoryStore.students.get(id) || null;
}

export async function saveStudent(student: StudentMaster): Promise<StudentMaster> {
  await initializeDatabase();
  const now = new Date().toISOString();
  const toSave: StudentMaster = {
    ...student,
    updatedAt: now,
    createdAt: student.createdAt || now,
  };

  memoryStore.students.set(toSave.id, toSave);

  try {
    await setDoc(doc(firestoreDb, 'students', toSave.id), toSave);
  } catch (err) {
    console.error('Error saving student to Firestore:', err);
  }
  return toSave;
}

export async function deleteStudent(id: string): Promise<boolean> {
  await initializeDatabase();
  memoryStore.students.delete(id);
  try {
    await deleteDoc(doc(firestoreDb, 'students', id));
    return true;
  } catch (err) {
    console.error('Error deleting student from Firestore:', err);
    return true;
  }
}
