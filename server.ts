import express from 'express';
import { google } from 'googleapis';
import cookieSession from 'cookie-session';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };

console.log('[SERVER] Starting initialization...');

dotenv.config();

// Initialize Firebase Admin Helper
let _db: FirebaseFirestore.Firestore | null = null;

function getDb() {
  if (_db) return _db;

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        projectId: firebaseConfig.projectId,
      });
    }

    _db = getFirestore(
      admin.app(),
      firebaseConfig.firestoreDatabaseId
    );

    return _db;
  } catch (e) {
    console.error('[FIREBASE] CRITICAL INITIALIZATION ERROR:', e);
    return null;
  }
}

// Initialize once at startup if possible
// getDb();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Health check
app.get('/api/health', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    version: '1.3.3',
    dbInitialized: !!getDb(),
    projectId: (admin.apps && admin.apps.length > 0) ? admin.app().options.projectId : 'none'
  });
});

app.use(express.json());
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'semillero-secret'],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  secure: true,
  sameSite: 'none',
  httpOnly: true,
  overwrite: true,
  proxy: true // CRITICAL for Cloud Run
}));

app.set('trust proxy', true); // More robust than '1'

const getRedirectUri = (req?: any) => {
  // Prioridad 1: Detectar dinámicamente desde los headers (ESENCIAL para dominios personalizados)
  if (req) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const protocol = req.headers['x-forwarded-proto'] || (host && host.includes('localhost') ? 'http' : 'https');
    
    if (host) {
      // Forzar HTTPS en producción (Cloud Run/Dominios personalizados)
      // Solo usar HTTP si es localhost
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const uri = `${protocol}://${host}/auth/callback`;
      return uri;
    }
  }

  // Prioridad 2: Usar APP_URL si está configurado con un valor real
  if (process.env.APP_URL && !['MY_APP_URL', '', 'undefined'].includes(process.env.APP_URL)) {
    const uri = `${process.env.APP_URL.replace(/\/$/, '')}/auth/callback`;
    return uri;
  }

  // Fallback para desarrollo local
  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/auth/callback`;
};

const getOAuth2Client = (tokens?: any, req?: any) => {
  const currentRedirectUri = getRedirectUri(req);
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('CRITICAL: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.');
  }
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    currentRedirectUri
  );
  if (tokens) client.setCredentials(tokens);
  return client;
};

const SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.rosters.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.students.readonly',
  'https://www.googleapis.com/auth/classroom.profile.emails',
  'https://www.googleapis.com/auth/classroom.profile.photos',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email'
];

// Hardcoded initial admins (will be synced to Firestore if missing)
const INITIAL_ADMINS = ['marinsekaxel@gmail.com', 'admin@semillerodigital.org'];

async function ensureAdminsExist() {
    const db = getDb();
    if (db) {
      for (const email of INITIAL_ADMINS) {
        const adminRef = db.collection('admins').doc(email.toLowerCase());
        const document = await adminRef.get();
        if (!document.exists) {
          await adminRef.set({ email: email.toLowerCase() });
        }
      }
    }
}

// Classroom Routes
app.get('/api/auth/url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('CRITICAL: GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET is missing.');
    return res.status(500).json({ error: 'Faltan las credenciales de Google (Client ID o Secret). Configúralas en el panel de Secrets de AI Studio.' });
  }
  const client = getOAuth2Client(undefined, req);
  const currentRedirectUri = getRedirectUri(req);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account consent'
  });
  res.json({ url });
});

app.get('/auth/callback', async (req: any, res) => {
  const { code, error: googleError, error_description } = req.query;
  
  if (googleError) {
    return res.status(400).send(`Error de Google: ${googleError}. ${error_description || ''}`);
  }

  if (!code) {
    return res.status(400).send('Error: No se recibió el código de autorización de Google.');
  }

  try {
    const client = getOAuth2Client(undefined, req);
    const { tokens } = await client.getToken(code as string);
    req.session.tokens = tokens;
    
    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS', tokens: ${JSON.stringify(tokens)} }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Autenticación exitosa. Puedes cerrar esta ventana.</p>
        </body>
      </html>
    `);
  } catch (error: any) {
    console.error('Error in callback:', error);
    const errorMessage = error.response?.data?.error_description || error.message || 'Error desconocido';
    res.status(500).send(`Error de autenticación: ${errorMessage}`);
  }
});

app.get('/api/auth/profile', async (req: any, res) => {
  let tokens = null;
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const base64 = authHeader.split(' ')[1];
      const decoded = Buffer.from(base64, 'base64').toString();
      tokens = JSON.parse(decoded);
    } catch (e: any) {
      console.error('Error decoding Authorization header:', e.message);
    }
  }
  
  if (!tokens && req.session?.tokens) {
    tokens = req.session.tokens;
  }
  
  if (!tokens) {
    return res.status(401).json({ error: 'No tokens found' });
  }

  try {
    const client = getOAuth2Client(tokens, req);
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data } = await oauth2.userinfo.get();
    
    const email = data.email?.toLowerCase();
    
    let isAdmin = false;
    const isHardcodedAdmin = INITIAL_ADMINS.includes(email || '');
    
    const db = getDb();
    if (db) {
      try {
        const adminDoc = await db.collection('admins').doc(email || '').get();
        isAdmin = adminDoc.exists;
      } catch (dbError: any) {
        isAdmin = isHardcodedAdmin;
      }
    } else {
      isAdmin = isHardcodedAdmin;
    }

    if (isHardcodedAdmin) isAdmin = true;

    res.json({ ...data, isAdmin, tokens });
  } catch (error: any) {
    console.error('Profile fetch failed:', error.message);
    res.status(401).json({ error: 'Auth check failed', details: error.message });
  }
});

app.get('/api/auth/logout', (req: any, res) => {
  req.session = null;
  res.json({ success: true });
});

// Admin & Group Management
app.get('/api/debug-db', async (req, res) => {
  try {
    const db = getDb();
    if (!db) return res.status(500).json({ error: 'Database not initialized' });

    const app = admin.app();
    const snapshot = await db.collection('admins').limit(1).get();

    res.json({
      databaseId: firebaseConfig.firestoreDatabaseId,
      projectId: app.options.projectId,
      connected: true,
      sampleDocFound: !snapshot.empty,
      env: process.env.NODE_ENV
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admins', async (req, res) => {
  const db = getDb();
  try {
    if (!db) return res.json(INITIAL_ADMINS);
    const snapshot = await db.collection('admins').get();
    const adminList = snapshot.docs.map(doc => doc.id);
    res.json(adminList);
  } catch (err) {
    console.error('Error fetching admins from Firestore:', err);
    res.json(INITIAL_ADMINS); // Fallback to hardcoded admins
  }
});

const getTokens = (req: any) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const base64 = authHeader.split(' ')[1];
      if (base64) {
        return JSON.parse(Buffer.from(base64, 'base64').toString());
      }
    } catch (e) {
      // Invalid header format
    }
  }
  return req.session?.tokens;
};

// Classroom Routes
app.get('/api/courses', async (req: any, res) => {
  const tokens = getTokens(req);
  if (!tokens) return res.status(401).json({ error: 'No tokens' });

  try {
    const client = getOAuth2Client(tokens, req);
    const classroom = google.classroom({ version: 'v1', auth: client });
    
    const [teacherRes, studentRes] = await Promise.all([
      classroom.courses.list({ teacherId: 'me' }),
      classroom.courses.list({ studentId: 'me' })
    ]);

    const allRawCourses = [
      ...(teacherRes.data.courses || []).map(c => ({ ...c, source: 'TEACHER' })),
      ...(studentRes.data.courses || []).map(c => ({ ...c, source: 'STUDENT' }))
    ];

    const courses = allRawCourses.map(c => ({
      id: c.id,
      name: c.name,
      section: c.section,
      alternateLink: c.alternateLink,
      role: c.source,
      courseState: c.courseState
    }));

    // Filter unique courses (in case someone is both)
    const uniqueCourses = Array.from(new Map(courses.map(c => [c.id, c])).values());
    
    // Add group info
    const userEmail = req.query.email as string;
    
    const coursesWithGroups = await Promise.all(uniqueCourses.map(async (c) => {
      if (!userEmail) return { ...c, userGroupId: null };
      let groupId = null;
      const db = getDb();
      if (db) {
        try {
          const groupDoc = await db.collection('groups').doc(c.id!).get();
          const groupData = groupDoc.data();
          groupId = groupData?.teachers?.[userEmail] || null;
        } catch (e) {
          console.error(`Error fetching group for course ${c.id}:`, e);
        }
      }
      return { ...c, userGroupId: groupId };
    }));

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json(coursesWithGroups);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

app.get('/api/courses/:id/students', async (req: any, res) => {
  const tokens = getTokens(req);
  if (!tokens) return res.status(401).json({ error: 'No tokens' });

  try {
    const client = getOAuth2Client(tokens, req);
    const classroom = google.classroom({ version: 'v1', auth: client });
    
    let allStudents: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: any = await classroom.courses.students.list({
        courseId: req.params.id,
        pageSize: 1000,
        pageToken,
        fields: 'students(profile(name/fullName,emailAddress,id,photoUrl)),nextPageToken'
      });
      allStudents = allStudents.concat(response.data.students || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    let groupData: any = null;
    const db = getDb();
    if (db) {
      try {
        const groupDoc = await db.collection('groups').doc(req.params.id).get();
        groupData = groupDoc.data();
      } catch (e) {
        console.error('Error fetching group data for students:', e);
      }
    }

    const studentsWithGroups = allStudents.map(s => ({
      ...s,
      groupId: groupData?.students?.[s.profile.emailAddress] || null
    }));

    res.json(studentsWithGroups);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

app.get('/api/courses/:id/teachers', async (req: any, res) => {
  const tokens = getTokens(req);
  if (!tokens) return res.status(401).json({ error: 'No tokens' });

  try {
    const client = getOAuth2Client(tokens, req);
    const classroom = google.classroom({ version: 'v1', auth: client });
    const response = await classroom.courses.teachers.list({ courseId: req.params.id });
    
    let groupData: any = null;
    const db = getDb();
    if (db) {
      try {
        const groupDoc = await db.collection('groups').doc(req.params.id).get();
        groupData = groupDoc.data();
      } catch (e) {
        console.error('Error fetching group data for teachers:', e);
      }
    }

    const teachersWithGroups = (response.data.teachers || []).map(t => ({
      ...t,
      groupId: groupData?.teachers?.[t.profile?.emailAddress || ''] || null
    }));

    res.json(teachersWithGroups);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

app.get('/api/courses/:id/coursework', async (req: any, res) => {
  const tokens = getTokens(req);
  if (!tokens) return res.status(401).json({ error: 'No tokens' });

  try {
    const client = getOAuth2Client(tokens, req);
    const classroom = google.classroom({ version: 'v1', auth: client });
    
    let allCourseWork: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: any = await classroom.courses.courseWork.list({
        courseId: req.params.id,
        pageSize: 1000,
        pageToken,
        orderBy: 'updateTime desc'
      });
      allCourseWork = allCourseWork.concat(response.data.courseWork || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    res.json(allCourseWork);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

app.get('/api/courses/:id/submissions', async (req: any, res) => {
  const tokens = getTokens(req);
  if (!tokens) return res.status(401).json({ error: 'No tokens' });

  try {
    const client = getOAuth2Client(tokens, req);
    const classroom = google.classroom({ version: 'v1', auth: client });
    
    let allSubmissions: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response: any = await classroom.courses.courseWork.studentSubmissions.list({
        courseId: req.params.id,
        courseWorkId: '-',
        pageSize: 1000,
        pageToken
      });
      allSubmissions = allSubmissions.concat(response.data.studentSubmissions || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    res.json(allSubmissions);
  } catch (error) {
    res.status(500).json({ error: (error as any).message });
  }
});

app.post('/api/admins', async (req, res) => {
  const { email } = req.body;
  const db = getDb();
  try {
    if (!db) throw new Error('Database not available');
    if (email) {
      await db.collection('admins').doc(email.toLowerCase()).set({ email: email.toLowerCase() });
    }
    const snapshot = await db.collection('admins').get();
    res.json(snapshot.docs.map(doc => doc.id));
  } catch (err: any) {
    console.error('Error saving admin:', err.message);
    res.status(500).json({ error: 'Error al guardar administrador: ' + err.message });
  }
});

app.delete('/api/admins/:email', async (req, res) => {
  const email = req.params.email.toLowerCase();
  const db = getDb();
  try {
    if (!db) throw new Error('Database not available');
    if (email !== 'marinsekaxel@gmail.com' && email !== 'admin@semillerodigital.org') {
      await db.collection('admins').doc(email).delete();
    }
    const snapshot = await db.collection('admins').get();
    res.json(snapshot.docs.map(doc => doc.id));
  } catch (err: any) {
    console.error('Error deleting admin:', err.message);
    res.status(500).json({ error: 'Error al eliminar administrador: ' + err.message });
  }
});

app.get('/api/groups/:courseId', async (req, res) => {
  const { courseId } = req.params;
  const db = getDb();
  try {
    if (!db) return res.status(500).json({ error: 'Base de datos no disponible' });
    const doc = await db.collection('groups').doc(courseId).get();
    if (doc.exists) {
      res.json(doc.data());
    } else {
      res.json({ count: 1, teachers: {}, students: {} });
    }
  } catch (err: any) {
    res.status(500).json({ error: 'Error al recuperar grupos: ' + err.message });
  }
});

app.post('/api/groups/:courseId', async (req, res) => {
  const { courseId } = req.params;
  const { count, teachers, students } = req.body;
  const db = getDb();
  try {
    if (!db) return res.status(500).json({ error: 'Base de datos no disponible' });
    
    const data = {
      count: count || 1,
      teachers: teachers || {},
      students: students || {},
      updatedAt: FieldValue.serverTimestamp()
    };

    await db.collection('groups').doc(courseId).set(data);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: 'Error al guardar grupos: ' + err.message });
  }
});

async function startServer() {
  console.log(`NODE_ENV: ${process.env.NODE_ENV}`);
  
  // Initialize DB and Sync Admins
  const db = getDb();
  if (db) {
    ensureAdminsExist().catch(err => console.error('Error syncing admins:', err));
  }

  if (process.env.NODE_ENV !== 'production') {
    console.log('--- MODO DESARROLLO (Vite Middleware) ---');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('--- MODO PRODUCCIÓN (Serviendo desde dist/) ---');
    console.log(`Build Timestamp: ${new Date().toISOString()}`);
    const distPath = path.join(process.cwd(), 'dist');
    // Disable automatic index.html serving to ensure our custom handler with headers is used
    app.use(express.static(distPath, { index: false }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Ready at http://0.0.0.0:${PORT} (v1.3.3)`);
  });
}

startServer();
