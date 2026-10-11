import { AppShell } from '@/features/layout';
import HomePage from '@/features/home/HomePage';
import LoginPage from '@/features/auth/LoginPage';
import AdminAudit from '@/features/admin/AdminAudit';
import AdminRoles from '@/features/admin/AdminRoles';
import AdminUsage from '@/features/admin/AdminUsage';
import AdminUsers from '@/features/admin/AdminUsers';
import AdminLayout from '@/features/admin/AdminLayout';
import ChatWorkspace from '@/features/chat/ChatWorkspace';
import HealthPanel from '@/features/projects/HealthPanel';
import { Navigate, Route, Routes } from 'react-router-dom';
import AdminProjects from '@/features/admin/AdminProjects';
import SearchPanel from '@/features/knowledge/SearchPanel';
import ProjectsPage from '@/features/projects/ProjectsPage';
import ProtectedRoute from '@/features/auth/ProtectedRoute';
import SourcesPanel from '@/features/projects/SourcesPanel';
import AdminRetention from '@/features/admin/AdminRetention';
import ChangesPanel from '@/features/knowledge/ChangesPanel';
import NotFoundPage from '@/features/not-found/NotFoundPage';
import ConversationsPage from '@/features/chat/ConversationsPage';
import ProjectOverview from '@/features/projects/ProjectOverview';
import ChangePasswordPage from '@/features/auth/ChangePasswordPage';
import ProjectDetailPage from '@/features/projects/ProjectDetailPage';
import ProjectPickerPage from '@/features/projects/ProjectPickerPage';
import KnowledgeExplorer from '@/features/knowledge/KnowledgeExplorer';
import ProcessingCenterPage from '@/features/projects/processing/ProcessingCenterPage';

/**
 * Application route tree matching the Base44 App structure.
 *
 * @returns React Router Routes element.
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<ProtectedRoute />}>
        <Route path="/change-password" element={<ChangePasswordPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />}>
            <Route index element={<ProjectOverview />} />
            <Route path="chat" element={<ChatWorkspace />} />
            <Route path="knowledge" element={<KnowledgeExplorer />} />
            <Route path="search" element={<SearchPanel />} />
            <Route path="changes" element={<ChangesPanel />} />
            <Route path="sources" element={<SourcesPanel />} />
            <Route path="health" element={<HealthPanel />} />
          </Route>
          <Route path="/chat" element={<ProjectPickerPage tab="chat" />} />
          <Route path="/knowledge" element={<ProjectPickerPage tab="knowledge" />} />
          <Route path="/search" element={<ProjectPickerPage tab="search" />} />
          <Route path="/conversations" element={<ConversationsPage />} />
          <Route path="/processing" element={<ProcessingCenterPage />} />
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<Navigate to="/admin/users" replace />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="roles" element={<AdminRoles />} />
            <Route path="projects" element={<AdminProjects />} />
            <Route path="retention" element={<AdminRetention />} />
            <Route path="usage" element={<AdminUsage />} />
            <Route path="audit" element={<AdminAudit />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
