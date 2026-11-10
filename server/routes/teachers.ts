import { Router, Request, Response } from 'express';
import {
  getAllUsers,
  getUserById,
  saveUser,
  deleteUser,
  getUserByUsername,
} from '../db/firebase.ts';
import {
  generateUniqueTeacherUsername,
  generateRandomPassword,
  processTeacherExcel,
} from '../utils/excel.ts';
import type { User } from '../../src/types/index.ts';

const router = Router();

// GET /api/teachers - List all teachers
router.get('/', async (req: Request, res: Response) => {
  try {
    const allUsers = await getAllUsers();
    const teachers = allUsers.filter((u) => u.role === 'teacher');
    return res.json({ teachers });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to retrieve teachers' });
  }
});

// POST /api/teachers - Create individual teacher profile
// The username and password shall automatically be assigned by the system, ensuring unique usernames
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, employeeId, contactNumber, emailId } = req.body;

    if (!name || !name.trim() || !employeeId || !employeeId.trim()) {
      return res.status(400).json({ error: 'Name and Employee ID are required to provision profile' });
    }

    // Check if employeeId is already registered
    const allUsers = await getAllUsers();
    const existingEmp = allUsers.find(
      (u) => u.employeeId && u.employeeId.toLowerCase() === employeeId.trim().toLowerCase()
    );
    if (existingEmp) {
      return res.status(400).json({
        error: `Employee ID "${employeeId.trim()}" is already registered for ${existingEmp.name}.`,
      });
    }

    // Collect all existing usernames to guarantee strict uniqueness
    const existingUsernames = new Set<string>(allUsers.map((u) => u.username.toLowerCase()));

    // System automatically generates unique username and randomized secure password
    const autoUsername = generateUniqueTeacherUsername(name.trim(), employeeId.trim(), existingUsernames);
    const autoPassword = generateRandomPassword(9);

    const id = `teacher-${employeeId.trim().toLowerCase().replace(/[^a-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
    const newTeacher: User = {
      id,
      username: autoUsername,
      password: autoPassword,
      role: 'teacher',
      name: name.trim(),
      employeeId: employeeId.trim(),
      contactNumber: contactNumber?.trim() || undefined,
      emailId: emailId?.trim() || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const saved = await saveUser(newTeacher);
    return res.status(201).json({ teacher: saved });
  } catch (err: any) {
    console.error('Error creating teacher:', err);
    return res.status(500).json({ error: 'Failed to create teacher profile' });
  }
});

// PUT /api/teachers/:id - Update teacher profile
// Admin has option only to alter/view password (and contact details); username is immutable
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const existing = await getUserById(id);
    if (!existing || existing.role !== 'teacher') {
      return res.status(404).json({ error: 'Teacher profile not found' });
    }

    const { name, employeeId, password, contactNumber, emailId } = req.body;

    // Check employeeId conflict if employeeId is being updated
    if (employeeId && employeeId.trim().toLowerCase() !== (existing.employeeId || '').toLowerCase()) {
      const allUsers = await getAllUsers();
      const conflict = allUsers.find(
        (u) => u.id !== id && u.employeeId && u.employeeId.toLowerCase() === employeeId.trim().toLowerCase()
      );
      if (conflict) {
        return res.status(400).json({
          error: `Employee ID "${employeeId.trim()}" is already assigned to ${conflict.name}.`,
        });
      }
    }

    const updated: User = {
      ...existing,
      // Username remains system-assigned and locked
      username: existing.username,
      // Admin alters password
      password: password !== undefined && password.trim() ? password.trim() : existing.password,
      name: name !== undefined ? name.trim() : existing.name,
      employeeId: employeeId !== undefined ? employeeId.trim() : existing.employeeId,
      contactNumber: contactNumber !== undefined ? contactNumber.trim() : existing.contactNumber,
      emailId: emailId !== undefined ? emailId.trim() : existing.emailId,
      updatedAt: new Date().toISOString(),
    };

    const saved = await saveUser(updated);
    return res.json({ teacher: saved });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to update teacher profile' });
  }
});

// DELETE /api/teachers/:id - Remove teacher profile
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const existing = await getUserById(id);
    if (!existing || existing.role !== 'teacher') {
      return res.status(404).json({ error: 'Teacher profile not found' });
    }

    await deleteUser(id);
    return res.json({ success: true, message: 'Teacher profile removed' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to delete teacher' });
  }
});

// POST /api/teachers/upload-excel - Bulk upload from Excel with guaranteed unique usernames
router.post('/upload-excel', async (req: Request, res: Response) => {
  try {
    const { base64Data } = req.body;
    if (!base64Data) {
      return res.status(400).json({ error: 'No Excel file data received' });
    }

    const buffer = Buffer.from(base64Data, 'base64');

    // Collect all existing usernames from DB to guarantee uniqueness across bulk file rows
    const allUsers = await getAllUsers();
    const existingUsernames = new Set<string>(allUsers.map((u) => u.username.toLowerCase()));

    const summary = processTeacherExcel(buffer, existingUsernames);

    // Save all valid teacher records into Firestore persistent DB
    const persistedRecords: User[] = [];
    for (const item of summary.createdRecords) {
      const userDoc: User = {
        id: item.id,
        name: item.name,
        employeeId: item.employeeId,
        role: 'teacher',
        username: item.username,
        password: item.password,
        contactNumber: item.contactNumber,
        emailId: item.emailId,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
      };

      const saved = await saveUser(userDoc);
      persistedRecords.push(saved);
    }

    return res.json({
      summary: {
        ...summary,
        createdRecords: persistedRecords,
      },
    });
  } catch (err: any) {
    console.error('Excel processing error for teachers:', err);
    return res.status(500).json({ error: 'Failed to parse teacher Excel file: ' + err.message });
  }
});

export default router;
