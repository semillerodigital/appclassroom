import React, { useState, useEffect, useMemo } from 'react';
import { 
  LogOut, 
  Search, 
  ExternalLink, 
  Download, 
  BarChart2, 
  Users, 
  ChevronDown, 
  Plus, 
  X, 
  Calendar, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  Settings,
  UserCheck,
  FileText,
  Trash2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  Legend, 
  ResponsiveContainer,
  Cell
} from 'recharts';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy,
  Timestamp,
  doc,
  getDocFromServer,
  deleteDoc
} from 'firebase/firestore';
import { 
  signInWithCredential, 
  GoogleAuthProvider,
  onAuthStateChanged
} from 'firebase/auth';
import { db, auth } from './firebase';

// --- Types ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

const ErrorBoundary = ({ children }: { children: React.ReactNode }) => {
  const [hasError, setHasError] = useState(false);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      try {
        const parsed = JSON.parse(event.message);
        if (parsed.error) setErrorInfo(parsed.error);
        else setErrorInfo(event.message);
      } catch {
        setErrorInfo(event.message);
      }
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
        <div className="bg-white p-8 rounded-[32px] shadow-xl max-w-md w-full text-center">
          <AlertCircle className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h1 className="text-2xl font-bold text-gray-900 mb-2">Algo salió mal</h1>
          <p className="text-gray-600 mb-6">{errorInfo || 'Ocurrió un error inesperado en la aplicación.'}</p>
          <button onClick={() => window.location.reload()} className="btn-primary w-full justify-center">
            Reiniciar Aplicación
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};

interface UserProfile {
  id: string;
  email: string;
  name: string;
  picture: string;
  isAdmin: boolean;
}

interface Course {
  id: string;
  name: string;
  section?: string;
  alternateLink: string;
  role: 'TEACHER' | 'STUDENT';
  courseState: 'ACTIVE' | 'ARCHIVED' | 'PROVISIONED' | 'DECLINED' | 'SUSPENDED';
  userGroupId: number | null;
}

interface Student {
  profile: {
    id: string;
    name: { fullName: string };
    emailAddress: string;
    photoUrl?: string;
  };
  groupId: number | null;
}

interface Teacher {
  profile: {
    id: string;
    name: { fullName: string };
    emailAddress: string;
  };
  groupId: number | null;
}

interface CourseWork {
  id: string;
  title: string;
  alternateLink: string;
  creationTime: string;
}

interface Submission {
  id: string;
  courseWorkId: string;
  userId: string;
  state: 'NEW' | 'CREATED' | 'TURNED_IN' | 'RETURNED' | 'RECLAIMED_BY_STUDENT';
  assignedGrade?: number;
  alternateLink: string;
  updateTime: string;
}

interface ClassDay {
  id: string;
  date: string;
  description?: string;
  createdBy: string;
}

interface AttendanceRecord {
  studentId: string;
  studentName: string;
  studentEmail: string;
  present: boolean;
}

interface AttendanceSession {
  id?: string;
  courseId: string;
  classDayId: string;
  date: any;
  createdBy: string;
  records: AttendanceRecord[];
}

// --- Constants ---
const PRIMARY_COLOR = '#5926a9';
const LOGO_URL = 'https://semillerodigital.org/wp-content/uploads/2023/06/LOGO-SEMILLERO.png';

const APP_VERSION = '1.3.3 - Acceso Administrativo Restablecido';

export default function App() {
  const [tokens, setTokens] = useState<any>(() => {
    const saved = sessionStorage.getItem('classroom_tokens');
    console.log('App init: Loaded tokens from sessionStorage:', !!saved);
    return saved ? JSON.parse(saved) : null;
  });
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [teachers, setTeachers] = useState<Teacher[]>([]);
  const [courseWork, setCourseWork] = useState<CourseWork[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [courseCache, setCourseCache] = useState<Record<string, { students: Student[], teachers: Teacher[], courseWork: CourseWork[], submissions: Submission[] }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filters & UI State
  const [roleFilter, setRoleFilter] = useState<'ALL' | 'TEACHER' | 'STUDENT'>('ALL');
  const [stateFilter, setStateFilter] = useState<string>('ACTIVE');
  const [groupFilter, setGroupFilter] = useState<number | 'ALL'>('ALL');
  const [studentSearch, setStudentSearch] = useState('');
  const [taskFilter, setTaskFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [showStudentList, setShowStudentList] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showTeacherModal, setShowTeacherModal] = useState(false);
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [showIndividualReport, setShowIndividualReport] = useState<Student | null>(null);

  // Admin & Groups State
  const [admins, setAdmins] = useState<string[]>([]);
  const [groupConfig, setGroupConfig] = useState<{ count: number, teachers: any, students: any }>({ count: 1, teachers: {}, students: {} });

  // Attendance State
  const [classDays, setClassDays] = useState<ClassDay[]>([]);
  const [attendanceSessions, setAttendanceSessions] = useState<AttendanceSession[]>([]);
  const [showAttendanceModule, setShowAttendanceModule] = useState(false);
  const [selectedAttendanceDay, setSelectedAttendanceDay] = useState<ClassDay | null>(null);
  const [selectedAttendanceCourse, setSelectedAttendanceCourse] = useState<Course | null>(null);
  const [currentAttendanceRecords, setCurrentAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [attendanceLoading, setAttendanceLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<'COURSES' | 'ATTENDANCE'>('COURSES');
  const [isAuthReady, setIsAuthReady] = useState(false);

  const authHeader = useMemo(() => {
    if (!tokens) return {};
    return { 'Authorization': `Bearer ${btoa(JSON.stringify(tokens))}` };
  }, [tokens]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const syncFirebaseAuth = async () => {
      if (tokens?.id_token) {
        try {
          const credential = GoogleAuthProvider.credential(tokens.id_token);
          await signInWithCredential(auth, credential);
        } catch (err) {
          console.error('Error syncing with Firebase Auth:', err);
        }
      }
    };
    syncFirebaseAuth();
  }, [tokens]);

  useEffect(() => {
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();
  }, []);

  useEffect(() => {
    fetchProfile();
  }, [tokens]);

  useEffect(() => {
    if (tokens && userProfile) {
      fetchCourses();
    }
  }, [tokens, userProfile]);

  useEffect(() => {
    if (isAuthReady && auth.currentUser) {
      const q = query(collection(db, 'class_days'), orderBy('date', 'desc'));
      return onSnapshot(q, (snapshot) => {
        setClassDays(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as ClassDay)));
      }, (err) => handleFirestoreError(err, OperationType.GET, 'class_days'));
    }
  }, [isAuthReady]);

  useEffect(() => {
    if (isAuthReady && auth.currentUser) {
      const q = query(collection(db, 'attendance'), orderBy('date', 'desc'));
      return onSnapshot(q, (snapshot) => {
        setAttendanceSessions(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceSession)));
      }, (err) => handleFirestoreError(err, OperationType.GET, 'attendance'));
    }
  }, [isAuthReady]);

  useEffect(() => {
    if (selectedCourse) {
      fetchCourseDetails();
      fetchGroups();
    }
  }, [selectedCourse]);

  const fetchProfile = async () => {
    console.log('fetchProfile: Initiating call. Tokens available:', !!tokens);
    try {
      const res = await fetch('/api/auth/profile', { headers: authHeader });
      if (res.ok) {
        const data = await res.json();
        console.log('fetchProfile: Success. User:', data.email);
        setUserProfile(data);
        if (data.tokens && JSON.stringify(data.tokens) !== JSON.stringify(tokens)) {
          console.log('fetchProfile: Updating tokens from server');
          setTokens(data.tokens);
          sessionStorage.setItem('classroom_tokens', JSON.stringify(data.tokens));
        }
        if (data.isAdmin) fetchAdmins();
      } else if (res.status === 401) {
        const errData = await res.json().catch(() => ({}));
        console.warn('fetchProfile: 401 Unauthorized. Details:', errData);
        if (tokens) {
          console.log('fetchProfile: Tokens existed but were rejected. Reason:', errData.error || 'Unknown');
          // Only logout if it's a real token rejection, not just some transient error
          if (errData.error === 'Invalid or expired tokens' || errData.error === 'No tokens found') {
            handleLogout();
          }
        }
      } else {
        console.error('fetchProfile: Unexpected status:', res.status);
      }
    } catch (err) {
      console.error('Error fetching profile:', err);
    }
  };

  const fetchCourses = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/courses?email=${userProfile?.email || ''}`, { headers: authHeader });
      if (res.ok) {
        setCourses(await res.json());
      } else {
        const errData = await res.json();
        setError(`Error al cargar cursos: ${errData.error || res.statusText}`);
      }
    } catch (err) {
      setError('Error de conexión al cargar cursos');
    } finally {
      setLoading(false);
    }
  };

  const fetchCourseDetails = async () => {
    if (!selectedCourse) return;

    // Check cache first
    if (courseCache[selectedCourse.id]) {
      const cached = courseCache[selectedCourse.id];
      setStudents(cached.students);
      setTeachers(cached.teachers);
      setCourseWork(cached.courseWork);
      setSubmissions(cached.submissions);
      return;
    }

    console.log('Fetching details for course:', selectedCourse.id);
    setLoading(true);
    setError(null);
    try {
      const [studentsRes, teachersRes, workRes, subRes] = await Promise.all([
        fetch(`/api/courses/${selectedCourse.id}/students`, { headers: authHeader }),
        fetch(`/api/courses/${selectedCourse.id}/teachers`, { headers: authHeader }),
        fetch(`/api/courses/${selectedCourse.id}/coursework`, { headers: authHeader }),
        fetch(`/api/courses/${selectedCourse.id}/submissions`, { headers: authHeader })
      ]);

      const errors: string[] = [];
      let newStudents: Student[] = [];
      let newTeachers: Teacher[] = [];
      let newCourseWork: CourseWork[] = [];
      let newSubmissions: Submission[] = [];

      if (studentsRes.ok) {
        newStudents = await studentsRes.json();
        setStudents(newStudents);
      } else {
        const data = await studentsRes.json().catch(() => ({}));
        errors.push(`Alumnos: ${data.error || studentsRes.statusText}`);
      }

      if (teachersRes.ok) {
        newTeachers = await teachersRes.json();
        setTeachers(newTeachers);
      } else {
        const data = await teachersRes.json().catch(() => ({}));
        errors.push(`Profesores: ${data.error || teachersRes.statusText}`);
      }

      if (workRes.ok) {
        newCourseWork = await workRes.json();
        setCourseWork(newCourseWork);
      } else {
        const data = await workRes.json().catch(() => ({}));
        errors.push(`Tareas: ${data.error || workRes.statusText}`);
      }

      if (subRes.ok) {
        newSubmissions = await subRes.json();
        setSubmissions(newSubmissions);
      } else {
        const data = await subRes.json().catch(() => ({}));
        errors.push(`Entregas: ${data.error || subRes.statusText}`);
      }

      if (errors.length === 0) {
        setCourseCache(prev => ({
          ...prev,
          [selectedCourse.id]: {
            students: newStudents,
            teachers: newTeachers,
            courseWork: newCourseWork,
            submissions: newSubmissions
          }
        }));
      }

      if (errors.length > 0) {
        setError(`Error al cargar: ${errors.join(' | ')}`);
      }
    } catch (err) {
      console.error('Fetch error:', err);
      setError('Error de conexión al cargar detalles del curso');
    } finally {
      setLoading(false);
    }
  };

  const fetchAdmins = async () => {
    try {
      const res = await fetch('/api/admins', { headers: authHeader });
      if (res.ok) setAdmins(await res.json());
    } catch (err) {}
  };

  const fetchGroups = async () => {
    if (!selectedCourse) return;
    try {
      const res = await fetch(`/api/groups/${selectedCourse.id}`, { headers: authHeader });
      if (res.ok) {
        const data = await res.json();
        console.log('Fetched group config:', data);
        setGroupConfig(data);
      } else {
        console.error('Error fetching groups, status:', res.status);
      }
    } catch (err) {
      console.error('Connection error fetching groups:', err);
    }
  };

  const subscribeToAttendance = () => {
    if (!selectedCourse || !isAuthReady || !auth.currentUser) return;
    const q = query(
      collection(db, 'attendance'),
      where('courseId', '==', selectedCourse.id),
      orderBy('date', 'desc')
    );
    const path = 'attendance';
    return onSnapshot(q, (snapshot) => {
      const sessions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AttendanceSession));
      setAttendanceSessions(sessions);
    }, (err) => {
      handleFirestoreError(err, OperationType.GET, path);
    });
  };

  const handleLogin = async () => {
    // Open popup immediately to avoid Safari blocker
    const popup = window.open('about:blank', 'oauth_popup', 'width=600,height=700');
    if (!popup) {
      setError('El bloqueador de ventanas emergentes impidió el inicio de sesión. Por favor, permítelas.');
      return;
    }

    try {
      const res = await fetch('/api/auth/url?t=' + Date.now());
      const data = await res.json();
      if (!res.ok) {
        popup.close();
        setError(data.error || 'Error al iniciar la autenticación');
        return;
      }
      popup.location.href = data.url;
    } catch (err) {
      popup.close();
      setError('No se pudo iniciar la autenticación');
    }
  };

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        setTokens(event.data.tokens);
        sessionStorage.setItem('classroom_tokens', JSON.stringify(event.data.tokens));
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const handleLogout = () => {
    fetch('/api/auth/logout').catch(err => console.error('Error logging out from server:', err));
    setTokens(null);
    setUserProfile(null);
    setCourses([]);
    setSelectedCourse(null);
    sessionStorage.removeItem('classroom_tokens');
    auth.signOut().catch(err => console.error('Error signing out from Firebase:', err));
  };

  // --- Logic ---

  const filteredCourses = courses.filter(c => {
    const matchesRole = roleFilter === 'ALL' || c.role === roleFilter;
    const matchesGroup = groupFilter === 'ALL' || c.userGroupId === Number(groupFilter);
    const matchesState = stateFilter === 'ALL' || c.courseState === stateFilter;
    return matchesRole && matchesGroup && matchesState;
  });

  const teacherGroup = useMemo(() => {
    if (!selectedCourse || !userProfile) return null;
    return groupConfig.teachers[userProfile.email] || null;
  }, [selectedCourse, userProfile, groupConfig]);

  const visibleStudents = useMemo(() => {
    let list = students;
    if (!userProfile?.isAdmin && teacherGroup !== null) {
      list = list.filter(s => s.groupId === teacherGroup);
    }
    if (studentSearch) {
      const s = studentSearch.toLowerCase();
      list = list.filter(st => 
        st.profile.name.fullName.toLowerCase().includes(s) || 
        st.profile.emailAddress.toLowerCase().includes(s) ||
        st.profile.id.includes(s)
      );
    }
    return list.sort((a, b) => a.profile.name.fullName.localeCompare(b.profile.name.fullName));
  }, [students, teacherGroup, userProfile, studentSearch]);

  const getSubmissionStatus = (studentId: string, workId: string) => {
    const sub = submissions.find(s => s.userId === studentId && s.courseWorkId === workId);
    if (!sub) return { label: 'Pendiente', color: 'bg-orange-100 text-orange-700', icon: Clock, type: 'PENDING' };
    if (sub.state === 'RETURNED') return { label: `Calificado (${sub.assignedGrade || 'N/A'})`, color: 'bg-purple-100 text-purple-700', icon: CheckCircle2, type: 'GRADED', link: sub.alternateLink, date: sub.updateTime };
    if (sub.state === 'TURNED_IN') return { label: 'Entregado', color: 'bg-blue-100 text-blue-700', icon: FileText, type: 'SUBMITTED', link: sub.alternateLink, date: sub.updateTime };
    return { label: 'Pendiente', color: 'bg-orange-100 text-orange-700', icon: Clock, type: 'PENDING' };
  };

  const filteredTasks = useMemo(() => {
    let list = courseWork;
    if (taskFilter !== 'ALL') {
      list = list.filter(t => t.id === taskFilter);
    }
    return list;
  }, [courseWork, taskFilter]);

  const toggleTask = (id: string) => {
    const next = new Set(expandedTasks);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedTasks(next);
  };

  const saveGroups = async (newConfig: any) => {
    if (!selectedCourse) return;
    setLoading(true);
    try {
      console.log('Sending group config for course:', selectedCourse.id, newConfig);
      const res = await fetch(`/api/groups/${selectedCourse.id}`, {
        method: 'POST',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Fallo al guardar en el servidor');
      }
      setGroupConfig(newConfig);
      console.log('Group config saved successfully');
    } catch (err: any) {
      console.error('Error saving groups:', err);
      setError(`No se pudieron guardar los grupos: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const startAttendance = (course: Course, day: ClassDay) => {
    setSelectedAttendanceCourse(course);
    setSelectedAttendanceDay(day);
    
    // Fetch students if not in cache
    if (courseCache[course.id]) {
      setCurrentAttendanceRecords(courseCache[course.id].students.map(s => ({
        studentId: s.profile.id,
        studentName: s.profile.name.fullName,
        studentEmail: s.profile.emailAddress,
        present: true
      })));
    } else {
      setLoading(true);
      fetch(`/api/courses/${course.id}/students`, { headers: authHeader })
        .then(res => res.json())
        .then(data => {
          setCurrentAttendanceRecords(data.map((s: Student) => ({
            studentId: s.profile.id,
            studentName: s.profile.name.fullName,
            studentEmail: s.profile.emailAddress,
            present: true
          })));
        })
        .finally(() => setLoading(false));
    }
  };

  const saveAttendance = async () => {
    if (!selectedAttendanceCourse || !selectedAttendanceDay || !userProfile) return;
    const path = 'attendance';
    setAttendanceLoading(true);
    try {
      await addDoc(collection(db, path), {
        courseId: selectedAttendanceCourse.id,
        classDayId: selectedAttendanceDay.id,
        date: Timestamp.now(),
        createdBy: userProfile.email,
        records: currentAttendanceRecords
      });
      setSelectedAttendanceDay(null);
      setSelectedAttendanceCourse(null);
      setCurrentAttendanceRecords([]);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, path);
    } finally {
      setAttendanceLoading(false);
    }
  };

  const downloadPDF = async (elementId: string, filename: string) => {
    const element = document.getElementById(elementId);
    if (!element) return;
    const canvas = await html2canvas(element, { scale: 2 });
    const imgData = canvas.toDataURL('image/png');
    const pdf = new jsPDF('p', 'mm', 'a4');
    const imgProps = pdf.getImageProperties(imgData);
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    pdf.save(filename);
  };

  if (!tokens) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-semillero-light p-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="bg-white p-12 rounded-[40px] shadow-2xl max-w-md w-full text-center">
          <img src={LOGO_URL} alt="Semillero Digital" className="h-24 mx-auto mb-8" referrerPolicy="no-referrer" />
          <h1 className="text-3xl font-bold text-semillero-dark mb-4">Gestión de cursos</h1>
          <p className="text-gray-500 mb-8">Gestiona tus clases, alumnos y reportes de forma sencilla y profesional.</p>
          <button onClick={handleLogin} className="btn-primary w-full justify-center py-4 text-lg">
            Iniciar sesión con Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-semillero-light pb-20">
      <header className="bg-white shadow-sm border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex flex-col">
              <img src={LOGO_URL} alt="Semillero" className="h-10 cursor-pointer" onClick={() => { setSelectedCourse(null); setActiveTab('COURSES'); }} referrerPolicy="no-referrer" />
              <span className="text-[8px] font-bold text-gray-300 -mt-1 ml-1">v1.3.3</span>
              <span className="text-[6px] text-gray-200 ml-1">Actualizado: {new Date().toLocaleString()} (Acceso Admin)</span>
            </div>
            {selectedCourse && (
              <div className="flex items-center gap-2">
                <div className="h-6 w-[1px] bg-gray-200 mx-2" />
                <h2 className="text-lg font-bold text-semillero-dark truncate max-w-[200px] sm:max-w-md">{selectedCourse.name}</h2>
                {teacherGroup !== null && <span className="bg-semillero-primary/10 text-semillero-primary text-xs font-bold px-3 py-1 rounded-full">Grupo {teacherGroup}</span>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-4">
            <div className="hidden md:flex items-center gap-6 mr-6">
              <button 
                onClick={() => { setSelectedCourse(null); setActiveTab('COURSES'); }} 
                className={`text-sm font-bold transition-colors ${activeTab === 'COURSES' ? 'text-semillero-primary' : 'text-gray-400 hover:text-gray-600'}`}
              >
                Cursos
              </button>
              <button 
                onClick={() => { setSelectedCourse(null); setActiveTab('ATTENDANCE'); }} 
                className={`text-sm font-bold transition-colors ${activeTab === 'ATTENDANCE' ? 'text-semillero-primary' : 'text-gray-400 hover:text-gray-600'}`}
              >
                Asistencia
              </button>
            </div>
            {userProfile && (
              <div className="hidden sm:flex items-center gap-3 text-right">
                <div>
                  <p className="text-sm font-bold text-semillero-dark">{userProfile.name}</p>
                  <p className="text-[10px] text-gray-400">{userProfile.email}</p>
                </div>
                <img src={userProfile.picture} alt={userProfile.name} className="w-10 h-10 rounded-full border-2 border-semillero-primary/20" referrerPolicy="no-referrer" />
              </div>
            )}
            <button onClick={handleLogout} className="p-2 bg-gray-100 text-gray-600 rounded-full hover:bg-red-50 hover:text-red-600 transition-colors">
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {error && (
          <div className="mb-8 p-4 bg-red-50 border border-red-100 text-red-700 rounded-[20px] flex items-center justify-between">
            <div className="flex items-center gap-3">
              <AlertCircle className="w-5 h-5" />
              <p className="text-sm font-medium">{error}</p>
            </div>
            <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-full transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {loading && !selectedCourse && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-12 h-12 border-4 border-semillero-primary/20 border-t-semillero-primary rounded-full animate-spin mb-4" />
            <p className="text-gray-500 font-medium">Cargando cursos...</p>
          </div>
        )}

        {activeTab === 'COURSES' ? (
          <>
            {!selectedCourse ? (
              <div className="space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h1 className="text-3xl font-bold text-semillero-dark">Mis Cursos</h1>
                    <p className="text-gray-500">Selecciona una clase para gestionar a tus alumnos.</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    {userProfile?.isAdmin && (
                      <button onClick={() => setShowAdminModal(true)} className="btn-secondary">
                        <Settings className="w-4 h-4" /> Gestión de Accesos
                      </button>
                    )}
                    <div className="flex bg-white p-1 rounded-[20px] border border-gray-200 shadow-sm">
                      {(['ACTIVE', 'ARCHIVED', 'ALL'] as const).map(s => (
                        <button key={s} onClick={() => setStateFilter(s)} className={`px-4 py-1.5 rounded-[16px] text-xs font-bold transition-all ${stateFilter === s ? 'bg-semillero-primary text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'}`}>
                          {s === 'ACTIVE' ? 'Activos' : s === 'ARCHIVED' ? 'Archivados' : 'Todos'}
                        </button>
                      ))}
                    </div>
                    <div className="flex bg-white p-1 rounded-[20px] border border-gray-200 shadow-sm">
                      {(['ALL', 'TEACHER', 'STUDENT'] as const).map(r => (
                        <button key={r} onClick={() => setRoleFilter(r)} className={`px-4 py-1.5 rounded-[16px] text-xs font-bold transition-all ${roleFilter === r ? 'bg-semillero-primary text-white shadow-md' : 'text-gray-500 hover:bg-gray-50'}`}>
                          {r === 'ALL' ? 'Todos' : r === 'TEACHER' ? 'Dictando' : 'Inscripto'}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {filteredCourses.map(course => (
                    <motion.div key={course.id} whileHover={{ y: -5 }} onClick={() => setSelectedCourse(course)} className="card cursor-pointer group flex flex-col justify-between">
                      <div>
                        <div className="flex justify-between items-start mb-4">
                          <div className="flex flex-col gap-2">
                            <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider w-fit ${course.role === 'TEACHER' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                              {course.role === 'TEACHER' ? 'Profesor' : 'Alumno'}
                            </div>
                            <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider w-fit ${course.courseState === 'ACTIVE' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700'}`}>
                              {course.courseState}
                            </div>
                          </div>
                          {course.userGroupId && <div className="bg-semillero-primary text-white text-[10px] font-bold px-2 py-0.5 rounded-lg">G{course.userGroupId}</div>}
                        </div>
                        <h3 className="text-xl font-bold text-semillero-dark group-hover:text-semillero-primary transition-colors mb-1">{course.name}</h3>
                        <p className="text-sm text-gray-400">{course.section || 'Sin sección'}</p>
                      </div>
                      <div className="mt-6 flex items-center justify-between text-semillero-primary font-bold text-sm">
                        <span>Ver detalles</span>
                        <ChevronDown className="w-5 h-5 -rotate-90" />
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
          ) : (
            <div className="space-y-8">
              {loading ? (
                <div className="flex flex-col items-center justify-center py-20">
                  <div className="w-12 h-12 border-4 border-semillero-primary/20 border-t-semillero-primary rounded-full animate-spin mb-4" />
                  <p className="text-gray-500 font-medium">Cargando detalles de la clase...</p>
                </div>
              ) : (
                <>
                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6">
                    <div className="flex flex-wrap items-center gap-3">
                      <button onClick={() => setSelectedCourse(null)} className="btn-secondary px-4"><ChevronDown className="w-5 h-5 rotate-90" /> Volver</button>
                      <button onClick={() => setShowStudentList(true)} className="btn-primary"><Users className="w-4 h-4" /> Lista de Alumnos</button>
                      {userProfile?.isAdmin && (
                        <>
                          <button onClick={() => setShowReportModal(true)} className="btn-secondary bg-blue-50 border-blue-100 text-blue-700"><BarChart2 className="w-4 h-4" /> Ver Reporte General</button>
                          <button onClick={() => setShowTeacherModal(true)} className="btn-secondary">Ver Profesores</button>
                          <button onClick={() => setShowGroupModal(true)} className="btn-secondary">Gestionar Grupos</button>
                        </>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative flex-1 min-w-[200px]">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input type="text" placeholder="Buscar alumno..." value={studentSearch} onChange={(e) => setStudentSearch(e.target.value)} className="w-full pl-11 pr-4 py-2.5 bg-white border border-gray-200 rounded-[20px] focus:outline-none focus:ring-2 focus:ring-semillero-primary/20 text-sm" />
                      </div>
                      <select value={taskFilter} onChange={(e) => setTaskFilter(e.target.value)} className="px-4 py-2.5 bg-white border border-gray-200 rounded-[20px] text-sm focus:outline-none focus:ring-2 focus:ring-semillero-primary/20">
                        <option value="ALL">Todas las tareas</option>
                        {courseWork.map(tw => <option key={tw.id} value={tw.id}>{tw.title}</option>)}
                      </select>
                      <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-4 py-2.5 bg-white border border-gray-200 rounded-[20px] text-sm focus:outline-none focus:ring-2 focus:ring-semillero-primary/20">
                        <option value="ALL">Todos los estados</option>
                        <option value="SUBMITTED">Entregado</option>
                        <option value="GRADED">Calificado</option>
                        <option value="PENDING">Pendiente</option>
                      </select>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <h2 className="text-2xl font-bold text-semillero-dark flex items-center gap-2"><FileText className="w-6 h-6 text-semillero-primary" /> Entregas de Tareas</h2>
                    {filteredTasks.map(task => {
                      const isExpanded = expandedTasks.has(task.id);
                      const taskSubmissions = visibleStudents.map(s => ({ student: s, status: getSubmissionStatus(s.profile.id, task.id) })).filter(item => statusFilter === 'ALL' || item.status.type === statusFilter);
                      if (taskSubmissions.length === 0 && statusFilter !== 'ALL') return null;
                      return (
                        <div key={task.id} className="bg-white rounded-[32px] border border-gray-100 overflow-hidden shadow-sm">
                          <div className="p-6 flex items-center justify-between cursor-pointer hover:bg-gray-50 transition-colors" onClick={() => toggleTask(task.id)}>
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 bg-semillero-primary/10 rounded-2xl flex items-center justify-center text-semillero-primary"><FileText className="w-6 h-6" /></div>
                              <div>
                                <div className="flex items-center gap-2">
                                  <h3 className="font-bold text-lg text-semillero-dark">{task.title}</h3>
                                  <a href={task.alternateLink} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-semillero-primary"><ExternalLink className="w-4 h-4" /></a>
                                </div>
                                <p className="text-xs text-gray-400 flex items-center gap-1"><Calendar className="w-3 h-3" /> Creado el {new Date(task.creationTime).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <button className="p-2 rounded-full bg-gray-50 text-gray-400">{isExpanded ? <X className="w-5 h-5" /> : <Plus className="w-5 h-5" />}</button>
                          </div>
                          <AnimatePresence>
                            {isExpanded && (
                              <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }} className="border-t border-gray-50">
                                <div className="p-6 overflow-x-auto">
                                  <table className="w-full text-left">
                                    <thead>
                                      <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">
                                        <th className="pb-4">Alumno</th>
                                        <th className="pb-4">Grupo</th>
                                        <th className="pb-4">Estado</th>
                                        <th className="pb-4">Última Act.</th>
                                        <th className="pb-4 text-right">Acciones</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-50">
                                      {taskSubmissions.map(({ student, status }) => (
                                        <tr key={student.profile.id}>
                                          <td className="py-4">
                                            <div className="flex items-center gap-3">
                                              <img src={student.profile.photoUrl} className="w-8 h-8 rounded-full" referrerPolicy="no-referrer" />
                                              <div><p className="text-sm font-bold text-semillero-dark">{student.profile.name.fullName}</p><p className="text-[10px] text-gray-400">{student.profile.emailAddress}</p></div>
                                            </div>
                                          </td>
                                          <td className="py-4"><span className="text-xs text-gray-500">{student.groupId ? `Grupo ${student.groupId}` : '-'}</span></td>
                                          <td className="py-4"><div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold ${status.color}`}><status.icon className="w-3 h-3" />{status.label}</div></td>
                                          <td className="py-4"><span className="text-[10px] text-gray-400">{status.date ? new Date(status.date).toLocaleString() : '-'}</span></td>
                                          <td className="py-4 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                              {status.link && <a href={status.link} target="_blank" rel="noreferrer" className="p-2 text-gray-400 hover:text-semillero-primary"><ExternalLink className="w-4 h-4" /></a>}
                                              <button onClick={() => setShowIndividualReport(student)} className="p-2 text-gray-400 hover:text-semillero-primary"><BarChart2 className="w-4 h-4" /></button>
                                            </div>
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </>
      ) : (
        <AttendanceModule 
          userProfile={userProfile} 
          courses={courses} 
          classDays={classDays}
          attendanceSessions={attendanceSessions}
          authHeader={authHeader}
        />
      )}
    </main>

    <AnimatePresence>
        {/* Modals (Student List, Admin, Teacher, Group, Attendance, Reports) would go here - simplified for brevity */}
        {showStudentList && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-semillero-dark">Lista de Alumnos</h2>
                <button onClick={() => setShowStudentList(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
              </div>
              <div className="p-8 overflow-y-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">
                      <th className="pb-4">Alumno</th>
                      <th className="pb-4">ID</th>
                      <th className="pb-4">Email</th>
                      <th className="pb-4 text-right">Reporte</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {visibleStudents.map(s => (
                      <tr key={s.profile.id}>
                        <td className="py-4 font-bold text-sm">{s.profile.name.fullName}</td>
                        <td className="py-4 font-mono text-xs text-gray-500">{s.profile.id}</td>
                        <td className="py-4 text-sm text-gray-600">{s.profile.emailAddress}</td>
                        <td className="py-4 text-right"><button onClick={() => setShowIndividualReport(s)} className="btn-primary py-1 px-3 text-xs"><BarChart2 className="w-3 h-3" /> Reporte</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </motion.div>
          </div>
        )}

        {showTeacherModal && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content max-w-2xl">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-semillero-dark">Profesores del Curso</h2>
                <button onClick={() => setShowTeacherModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
              </div>
              <div className="p-8">
                <div className="space-y-4">
                  {teachers.map(t => (
                    <div key={t.profile.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-2xl">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-semillero-primary text-white rounded-full flex items-center justify-center font-bold">
                          {t.profile.name.fullName.charAt(0)}
                        </div>
                        <div>
                          <p className="font-bold text-semillero-dark">{t.profile.name.fullName}</p>
                          <p className="text-xs text-gray-500">{t.profile.emailAddress}</p>
                        </div>
                      </div>
                      {t.groupId && <span className="bg-semillero-primary/10 text-semillero-primary text-xs font-bold px-3 py-1 rounded-full">Grupo {t.groupId}</span>}
                    </div>
                  ))}
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showGroupModal && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content max-w-4xl">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-semillero-dark">Gestionar Grupos</h2>
                  <p className="text-sm text-gray-500">Asigna profesores y alumnos a grupos específicos.</p>
                </div>
                <button onClick={() => setShowGroupModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
              </div>
              <div className="p-8 space-y-8 max-h-[70vh] overflow-y-auto">
                <div className="flex items-center gap-4 p-4 bg-semillero-primary/5 rounded-2xl border border-semillero-primary/10">
                  <span className="text-sm font-bold text-semillero-dark">Cantidad de Grupos:</span>
                  <input 
                    type="number" 
                    min="1" 
                    max="10" 
                    value={groupConfig.count} 
                    onChange={(e) => saveGroups({ ...groupConfig, count: parseInt(e.target.value) || 1 })}
                    className="w-20 px-3 py-1 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-semillero-primary/20"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div>
                    <h3 className="font-bold text-semillero-dark mb-4 flex items-center gap-2"><Users className="w-4 h-4" /> Profesores</h3>
                    <div className="space-y-2">
                      {teachers.map(t => (
                        <div key={t.profile.id} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl">
                          <span className="text-sm font-medium">{t.profile.name.fullName}</span>
                          <select 
                            value={groupConfig.teachers[t.profile.emailAddress] || ''} 
                            onChange={(e) => {
                              const newTeachers = { ...groupConfig.teachers, [t.profile.emailAddress]: e.target.value ? parseInt(e.target.value) : null };
                              saveGroups({ ...groupConfig, teachers: newTeachers });
                            }}
                            className="text-xs border border-gray-200 rounded px-2 py-1"
                          >
                            <option value="">Sin Grupo</option>
                            {Array.from({ length: groupConfig.count }).map((_, i) => (
                              <option key={i+1} value={i+1}>Grupo {i+1}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <h3 className="font-bold text-semillero-dark mb-4 flex items-center gap-2"><Users className="w-4 h-4" /> Alumnos</h3>
                    <div className="space-y-2">
                      {students.map(s => (
                        <div key={s.profile.id} className="flex items-center justify-between p-3 bg-white border border-gray-100 rounded-xl">
                          <span className="text-sm font-medium">{s.profile.name.fullName}</span>
                          <select 
                            value={groupConfig.students[s.profile.emailAddress] || ''} 
                            onChange={(e) => {
                              const newStudents = { ...groupConfig.students, [s.profile.emailAddress]: e.target.value ? parseInt(e.target.value) : null };
                              saveGroups({ ...groupConfig, students: newStudents });
                            }}
                            className="text-xs border border-gray-200 rounded px-2 py-1"
                          >
                            <option value="">Sin Grupo</option>
                            {Array.from({ length: groupConfig.count }).map((_, i) => (
                              <option key={i+1} value={i+1}>Grupo {i+1}</option>
                            ))}
                          </select>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showReportModal && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content max-w-6xl">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-bold text-semillero-dark">Reporte General del Curso</h2>
                  <p className="text-sm text-gray-500">Visualización del progreso y asistencia de todos los alumnos.</p>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => downloadPDF('general-report', `Reporte_${selectedCourse?.name}.pdf`)} className="btn-secondary"><Download className="w-4 h-4" /> Exportar PDF</button>
                  <button onClick={() => setShowReportModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
                </div>
              </div>
              <div id="general-report" className="p-8 space-y-8 max-h-[80vh] overflow-y-auto bg-white">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="p-6 bg-blue-50 rounded-3xl border border-blue-100">
                    <p className="text-blue-600 text-sm font-bold uppercase tracking-wider mb-2">Total Alumnos</p>
                    <p className="text-4xl font-black text-blue-900">{students.length}</p>
                  </div>
                  <div className="p-6 bg-purple-50 rounded-3xl border border-purple-100">
                    <p className="text-purple-600 text-sm font-bold uppercase tracking-wider mb-2">Tareas Asignadas</p>
                    <p className="text-4xl font-black text-purple-900">{courseWork.length}</p>
                  </div>
                  <div className="p-6 bg-green-50 rounded-3xl border border-green-100">
                    <p className="text-green-600 text-sm font-bold uppercase tracking-wider mb-2">Sesiones de Asistencia</p>
                    <p className="text-4xl font-black text-green-900">{attendanceSessions.length}</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <h3 className="text-xl font-bold text-semillero-dark">Matriz de Cumplimiento</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="text-[10px] font-bold text-gray-400 uppercase tracking-widest border-b border-gray-100">
                          <th className="pb-4 pr-4 sticky left-0 bg-white z-10">Alumno</th>
                          {courseWork.map(tw => (
                            <th key={tw.id} className="pb-4 px-2 text-center min-w-[100px]">{tw.title}</th>
                          ))}
                          <th className="pb-4 pl-4 text-right">% Entrega</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {students.map(s => {
                          const studentSubs = submissions.filter(sub => sub.userId === s.profile.id);
                          const deliveredCount = studentSubs.filter(sub => sub.state === 'TURNED_IN' || sub.state === 'RETURNED').length;
                          const percentage = courseWork.length > 0 ? Math.round((deliveredCount / courseWork.length) * 100) : 0;
                          
                          return (
                            <tr key={s.profile.id} className="hover:bg-gray-50 transition-colors">
                              <td className="py-3 pr-4 sticky left-0 bg-white z-10 font-bold text-xs text-semillero-dark">{s.profile.name.fullName}</td>
                              {courseWork.map(tw => {
                                const sub = submissions.find(sub => sub.userId === s.profile.id && sub.courseWorkId === tw.id);
                                const isDelivered = sub?.state === 'TURNED_IN' || sub?.state === 'RETURNED';
                                return (
                                  <td key={tw.id} className="py-3 px-2 text-center">
                                    <div className={`w-3 h-3 rounded-full mx-auto ${isDelivered ? 'bg-green-500' : 'bg-red-200'}`} />
                                  </td>
                                );
                              })}
                              <td className="py-3 pl-4 text-right">
                                <span className={`font-bold text-xs ${percentage >= 70 ? 'text-green-600' : percentage >= 40 ? 'text-orange-500' : 'text-red-600'}`}>
                                  {percentage}%
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showAdminModal && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content max-w-md">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <h2 className="text-2xl font-bold text-semillero-dark">Gestión de Accesos</h2>
                <button onClick={() => setShowAdminModal(false)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
              </div>
              <div className="p-8 space-y-6">
                <div className="space-y-4">
                  <h3 className="font-bold text-sm text-gray-500 uppercase tracking-wider">Administradores</h3>
                  <div className="space-y-2">
                    {admins.map(email => (
                      <div key={email} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                        <span className="text-sm font-medium">{email}</span>
                        {(email !== 'marinsekaxel@gmail.com' && email !== 'admin@semillerodigital.org') && (
                          <button onClick={async () => {
                            await fetch(`/api/admins/${email}`, { method: 'DELETE', headers: authHeader });
                            fetchAdmins();
                          }} className="text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="font-bold text-sm text-gray-500 uppercase tracking-wider">Agregar Admin</h3>
                  <div className="flex gap-2">
                    <input id="new-admin-email" type="email" placeholder="email@ejemplo.com" className="flex-1 px-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-semillero-primary/20" />
                    <button onClick={async () => {
                      const input = document.getElementById('new-admin-email') as HTMLInputElement;
                      if (input.value) {
                        await fetch('/api/admins', { 
                          method: 'POST', 
                          headers: { ...authHeader, 'Content-Type': 'application/json' },
                          body: JSON.stringify({ email: input.value })
                        });
                        input.value = '';
                        fetchAdmins();
                      }
                    }} className="btn-primary py-2">Agregar</button>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

        {showIndividualReport && (
          <div className="modal-overlay">
            <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="modal-content max-w-4xl">
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <img src={showIndividualReport.profile.photoUrl} className="w-16 h-16 rounded-2xl shadow-md" referrerPolicy="no-referrer" />
                  <div>
                    <h2 className="text-2xl font-bold text-semillero-dark">{showIndividualReport.profile.name.fullName}</h2>
                    <p className="text-sm text-gray-500">{showIndividualReport.profile.emailAddress}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button onClick={() => downloadPDF(`report-${showIndividualReport.profile.id}`, `Reporte_${showIndividualReport.profile.name.fullName}.pdf`)} className="btn-secondary"><Download className="w-4 h-4" /> Exportar PDF</button>
                  <button onClick={() => setShowIndividualReport(null)} className="p-2 hover:bg-gray-100 rounded-full"><X className="w-6 h-6" /></button>
                </div>
              </div>
              <div id={`report-${showIndividualReport.profile.id}`} className="p-8 space-y-8 max-h-[70vh] overflow-y-auto bg-white">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  <div className="space-y-6">
                    <h3 className="font-bold text-lg text-semillero-dark border-b pb-2">Desempeño en Tareas</h3>
                    <div className="space-y-3">
                      {courseWork.map(tw => {
                        const sub = submissions.find(s => s.userId === showIndividualReport.profile.id && s.courseWorkId === tw.id);
                        const status = getSubmissionStatus(showIndividualReport.profile.id, tw.id);
                        return (
                          <div key={tw.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                            <span className="text-sm font-medium text-gray-700 truncate max-w-[200px]">{tw.title}</span>
                            <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${status.color}`}>{status.label}</div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div className="space-y-6">
                    <h3 className="font-bold text-lg text-semillero-dark border-b pb-2">Asistencia</h3>
                    <div className="space-y-3">
                      {attendanceSessions.filter(s => s.courseId === (selectedCourse?.id || '')).map(session => {
                        const day = classDays.find(d => d.id === session.classDayId);
                        const record = session.records.find(r => r.studentEmail === showIndividualReport.profile.emailAddress);
                        return (
                          <div key={session.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-xl">
                            <span className="text-sm font-medium text-gray-700">{day ? new Date(day.date + 'T12:00:00').toLocaleDateString() : 'Fecha desconocida'}</span>
                            <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${record?.present ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                              {record?.present ? 'Presente' : 'Ausente'}
                            </div>
                          </div>
                        );
                      })}
                      {attendanceSessions.filter(s => s.courseId === (selectedCourse?.id || '')).length === 0 && <p className="text-sm text-gray-400 italic">No hay registros de asistencia.</p>}
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        )}

      </AnimatePresence>
    </div>
    </ErrorBoundary>
  );
}

function AttendanceModule({ userProfile, courses, classDays, attendanceSessions, authHeader }: any) {
  const [newDate, setNewDate] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedDay, setSelectedDay] = useState<ClassDay | null>(null);
  const [selectedCourse, setSelectedCourse] = useState<Course | null>(null);
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const addClassDay = async () => {
    if (!newDate) return;
    try {
      await addDoc(collection(db, 'class_days'), {
        date: newDate,
        description: newDesc,
        createdBy: userProfile.email
      });
      setNewDate('');
      setNewDesc('');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'class_days');
    }
  };

  const deleteClassDay = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'class_days', id));
      if (selectedDay?.id === id) setSelectedDay(null);
      setConfirmDeleteId(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, 'class_days');
    }
  };

  const startAttendance = async (course: Course, day: ClassDay) => {
    setSelectedCourse(course);
    setSelectedDay(day);
    setLoading(true);
    try {
      const res = await fetch(`/api/courses/${course.id}/students`, { headers: authHeader });
      const students = await res.json();
      
      // Check if attendance already exists for this course and day
      const existing = attendanceSessions.find((s: any) => s.courseId === course.id && s.classDayId === day.id);
      
      if (existing) {
        setRecords(existing.records);
      } else {
        setRecords(students.map((s: any) => ({
          studentId: s.profile.id,
          studentName: s.profile.name.fullName,
          studentEmail: s.profile.emailAddress,
          present: true
        })));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const saveAttendance = async () => {
    if (!selectedCourse || !selectedDay) return;
    try {
      await addDoc(collection(db, 'attendance'), {
        courseId: selectedCourse.id,
        classDayId: selectedDay.id,
        date: Timestamp.now(),
        createdBy: userProfile.email,
        records: records
      });
      setSelectedCourse(null);
      setSelectedDay(null);
      setRecords([]);
      alert('Asistencia guardada con éxito');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'attendance');
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-semillero-dark">Control de Asistencia</h1>
          <p className="text-gray-500">Gestiona los días de clase y toma asistencia por curso.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Admin: Class Days Calendar/List */}
        <div className="lg:col-span-1 space-y-6">
          <div className="card p-6 space-y-6">
            <h2 className="text-xl font-bold text-semillero-dark flex items-center gap-2">
              <Calendar className="w-5 h-5 text-semillero-primary" /> Días de Clase
            </h2>
            
            {userProfile?.isAdmin && (
              <div className="space-y-4 p-4 bg-gray-50 rounded-2xl border border-gray-100">
                <p className="text-xs font-bold text-gray-400 uppercase tracking-widest">Programar Nuevo Día</p>
                <div className="space-y-3">
                  <input 
                    type="date" 
                    value={newDate} 
                    onChange={(e) => setNewDate(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-semillero-primary/20"
                  />
                  <input 
                    type="text" 
                    placeholder="Descripción (opcional)" 
                    value={newDesc} 
                    onChange={(e) => setNewDesc(e.target.value)}
                    className="w-full px-4 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-semillero-primary/20"
                  />
                  <button onClick={addClassDay} className="btn-primary w-full justify-center py-2">
                    <Plus className="w-4 h-4" /> Agregar Día
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
              {classDays.map((day: ClassDay) => (
                <div 
                  key={day.id} 
                  onClick={() => setSelectedDay(day)}
                  className={`p-4 rounded-2xl border cursor-pointer transition-all ${selectedDay?.id === day.id ? 'bg-semillero-primary text-white border-semillero-primary shadow-lg' : 'bg-white border-gray-100 hover:border-semillero-primary/30'}`}
                >
                  <div className="flex justify-between items-start">
                    <div className="flex-1">
                      <p className="font-bold">{new Date(day.date + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
                      {day.description && <p className={`text-xs ${selectedDay?.id === day.id ? 'text-white/80' : 'text-gray-400'}`}>{day.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      {attendanceSessions.some((s: any) => s.classDayId === day.id) && (
                        <CheckCircle2 className={`w-4 h-4 ${selectedDay?.id === day.id ? 'text-white' : 'text-green-500'}`} />
                      )}
                      {userProfile?.isAdmin && (
                        <div className="flex items-center gap-1">
                          {confirmDeleteId === day.id ? (
                            <>
                              <button 
                                onClick={(e) => { e.stopPropagation(); deleteClassDay(day.id); }}
                                className="p-1 rounded-lg bg-red-500 text-white text-[10px] font-bold uppercase"
                              >
                                Eliminar
                              </button>
                              <button 
                                onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}
                                className="p-1 rounded-lg bg-gray-200 text-gray-600 text-[10px] font-bold uppercase"
                              >
                                No
                              </button>
                            </>
                          ) : (
                            <button 
                              onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(day.id); }}
                              className={`p-1 rounded-full hover:bg-red-100 hover:text-red-600 transition-colors ${selectedDay?.id === day.id ? 'text-white/60 hover:text-white' : 'text-gray-300'}`}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {classDays.length === 0 && <p className="text-sm text-gray-400 italic text-center py-8">No hay días programados.</p>}
            </div>
          </div>
        </div>

        {/* Teacher: Course & Attendance Taker */}
        <div className="lg:col-span-2 space-y-6">
          {!selectedDay ? (
            <div className="card p-12 flex flex-col items-center justify-center text-center space-y-4">
              <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center text-gray-300">
                <Calendar className="w-8 h-8" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-semillero-dark">Selecciona un día</h3>
                <p className="text-sm text-gray-400">Elige un día de clase del calendario para comenzar a tomar asistencia.</p>
              </div>
            </div>
          ) : !selectedCourse ? (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-bold text-semillero-dark">Selecciona el Curso</h2>
                <span className="text-sm font-bold text-semillero-primary bg-semillero-primary/10 px-4 py-1 rounded-full">
                  {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString()}
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {courses.filter((c: any) => c.courseState === 'ACTIVE').map((course: Course) => (
                  <div 
                    key={course.id} 
                    onClick={() => startAttendance(course, selectedDay)}
                    className="card p-6 cursor-pointer hover:border-semillero-primary/30 transition-all group"
                  >
                    <div className="flex justify-between items-start mb-2">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${course.role === 'TEACHER' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                        {course.role === 'TEACHER' ? 'Profesor' : 'Alumno'}
                      </span>
                      {attendanceSessions.some((s: any) => s.classDayId === selectedDay.id && s.courseId === course.id) && (
                        <span className="text-[10px] font-bold text-green-600 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Completado
                        </span>
                      )}
                    </div>
                    <h3 className="font-bold text-semillero-dark group-hover:text-semillero-primary transition-colors">{course.name}</h3>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="card p-8 space-y-8">
              <div className="flex items-center justify-between border-b pb-6">
                <div>
                  <button onClick={() => setSelectedCourse(null)} className="text-xs text-semillero-primary font-bold hover:underline mb-1 flex items-center gap-1">
                    <ChevronDown className="w-3 h-3 rotate-90" /> Cambiar curso
                  </button>
                  <h2 className="text-2xl font-bold text-semillero-dark">{selectedCourse.name}</h2>
                  <p className="text-sm text-gray-400">Tomando asistencia para el {new Date(selectedDay.date + 'T12:00:00').toLocaleDateString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-semillero-dark">{records.filter(r => r.present).length} / {records.length}</p>
                  <p className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Presentes</p>
                </div>
              </div>

              {loading ? (
                <div className="flex flex-col items-center py-20">
                  <div className="w-10 h-10 border-4 border-semillero-primary/20 border-t-semillero-primary rounded-full animate-spin mb-4" />
                  <p className="text-gray-400 text-sm">Cargando alumnos...</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {records.map((record, idx) => (
                    <div key={record.studentId} className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${record.present ? 'bg-green-50 border-green-100' : 'bg-red-50 border-red-100'}`}>
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${record.present ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                          {record.studentName.charAt(0)}
                        </div>
                        <div className="max-w-[120px] sm:max-w-[180px]">
                          <p className="text-sm font-bold text-semillero-dark truncate">{record.studentName}</p>
                          <p className="text-[10px] text-gray-500 truncate">{record.studentEmail}</p>
                        </div>
                      </div>
                      <button 
                        onClick={() => {
                          const next = [...records];
                          next[idx].present = !next[idx].present;
                          setRecords(next);
                        }}
                        className={`px-4 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all ${record.present ? 'bg-green-500 text-white shadow-md' : 'bg-red-500 text-white shadow-md'}`}
                      >
                        {record.present ? 'Presente' : 'Ausente'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex justify-end pt-6 border-t">
                <button 
                  onClick={saveAttendance} 
                  disabled={loading || records.length === 0}
                  className="btn-primary px-12 py-3 text-lg disabled:opacity-50"
                >
                  Guardar Asistencia
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
