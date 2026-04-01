export type BoardProject = {
  id: number;
  name: string;
  key: string;
  workflowId: number;
};

export type BoardStatus = {
  id: number;
  name: string;
  color: string;
  sortOrder: number;
};

export type BoardIssue = {
  id: number;
  title: string;
  description: string;
  priority: string;
  createdAt: string;
  assignee: null | {
    id: number;
    name: string;
    email: string;
  };
  statusId: number;
};

