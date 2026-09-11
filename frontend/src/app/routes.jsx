import { Navigate, Route, Routes } from 'react-router-dom';
import AdminAudit from '@/features/admin/AdminAudit';
import AdminLayout from '@/features/admin/AdminLayout';
import AdminProjects from '@/features/admin/AdminProjects';
import AdminRetention from '@/features/admin/AdminRetention';
import AdminRoles from '@/features/admin/AdminRoles';
import AdminUsage from '@/features/admin/AdminUsage';
import AdminUsers from '@/features/admin/AdminUsers';
import ForgotPasswordPage from '@/features/auth/ForgotPasswordPage';
import LoginPage from '@/features/auth/LoginPage';
import ProtectedRoute from '@/features/auth/ProtectedRoute';
import RegisterPage from '@/features/auth/RegisterPage';
import ResetPasswordPage from '@/features/auth/ResetPasswordPage';
import ChatWorkspace from '@/features/chat/ChatWorkspace';
import ConversationsPage from '@/features/chat/ConversationsPage';
import HomePage from '@/features/home/HomePage';
import KnowledgeExplorer from '@/features/knowledge/KnowledgeExplorer';
import SearchPanel from '@/features/knowledge/SearchPanel';
import { AppShell } from '@/features/layout';
import NotFoundPage from '@/features/not-found/NotFoundPage';
import ProcessingCenterPage from '@/features/processing/ProcessingCenterPage';
import ChangesPanel from '@/features/projects/ChangesPanel';
import HealthPanel from '@/features/projects/HealthPanel';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import ProjectOverview from '@/features/projects/ProjectOverview';
import ProjectPickerPage from '@/features/projects/ProjectPickerPage';
import ProjectsPage from '@/features/projects/ProjectsPage';
import SourcesPanel from '@/features/projects/SourcesPanel';
/**
 * Application route tree matching the Base44 App structure.
 *
 * @returns React Router Routes element.
 */
export function AppRoutes() {
    return (<Routes>
      <Route path="/login" element={<LoginPage />}/>
      <Route path="/register" element={<RegisterPage />}/>
      <Route path="/forgot-password" element={<ForgotPasswordPage />}/>
      <Route path="/reset-password" element={<ResetPasswordPage />}/>

      <Route element={<ProtectedRoute unauthenticatedElement={<Navigate to="/login" replace/>}/>}>
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />}/>
          <Route path="/projects" element={<ProjectsPage />}/>
          <Route path="/projects/:id" element={<ProjectDetailPage />}>
            <Route index element={<ProjectOverview />}/>
            <Route path="chat" element={<ChatWorkspace />}/>
            <Route path="knowledge" element={<KnowledgeExplorer />}/>
            <Route path="search" element={<SearchPanel />}/>
            <Route path="changes" element={<ChangesPanel />}/>
            <Route path="sources" element={<SourcesPanel />}/>
            <Route path="health" element={<HealthPanel />}/>
          </Route>
          <Route path="/chat" element={<ProjectPickerPage tab="chat"/>}/>
          <Route path="/knowledge" element={<ProjectPickerPage tab="knowledge"/>}/>
          <Route path="/search" element={<ProjectPickerPage tab="search"/>}/>
          <Route path="/conversations" element={<ConversationsPage />}/>
          <Route path="/processing" element={<ProcessingCenterPage />}/>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/users" replace/>}/>
            <Route path="users" element={<AdminUsers />}/>
            <Route path="roles" element={<AdminRoles />}/>
            <Route path="projects" element={<AdminProjects />}/>
            <Route path="retention" element={<AdminRetention />}/>
            <Route path="usage" element={<AdminUsage />}/>
            <Route path="audit" element={<AdminAudit />}/>
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />}/>
    </Routes>);
}
