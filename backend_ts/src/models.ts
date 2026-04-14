import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  Sequelize,
} from 'sequelize';
import { env } from './config.js';

export const sequelize = new Sequelize(env.databaseUrl, {
  dialect: 'postgres',
  logging: false,
});

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<number>;
  declare username: string;
  declare passwordHash: string;
  declare role: string;
  declare createdAt: CreationOptional<Date>;
}

User.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    username: { type: DataTypes.STRING(100), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(255), allowNull: false, field: 'password_hash' },
    role: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'user' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'created_at' },
  },
  {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    underscored: true,
    timestamps: false,
  },
);

export class ChatSession extends Model<InferAttributes<ChatSession>, InferCreationAttributes<ChatSession>> {
  declare id: CreationOptional<number>;
  declare userId: number;
  declare sessionId: string;
  declare metadataJson: CreationOptional<Record<string, unknown>>;
  declare updatedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
}

ChatSession.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: false, field: 'user_id' },
    sessionId: { type: DataTypes.STRING(120), allowNull: false, field: 'session_id' },
    metadataJson: { type: DataTypes.JSONB, allowNull: false, defaultValue: {}, field: 'metadata_json' },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'updated_at' },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'created_at' },
  },
  {
    sequelize,
    modelName: 'ChatSession',
    tableName: 'chat_sessions',
    underscored: true,
    timestamps: false,
    indexes: [
      { name: 'uq_user_session', unique: true, fields: ['user_id', 'session_id'] },
      { fields: ['user_id'] },
      { fields: ['session_id'] },
    ],
  },
);

export class ChatMessage extends Model<InferAttributes<ChatMessage>, InferCreationAttributes<ChatMessage>> {
  declare id: CreationOptional<number>;
  declare sessionRefId: number;
  declare messageType: string;
  declare content: string;
  declare timestamp: CreationOptional<Date>;
  declare ragTrace: Record<string, unknown> | null;
}

ChatMessage.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    sessionRefId: { type: DataTypes.INTEGER, allowNull: false, field: 'session_ref_id' },
    messageType: { type: DataTypes.STRING(20), allowNull: false, field: 'message_type' },
    content: { type: DataTypes.TEXT, allowNull: false },
    timestamp: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    ragTrace: { type: DataTypes.JSONB, allowNull: true, field: 'rag_trace' },
  },
  {
    sequelize,
    modelName: 'ChatMessage',
    tableName: 'chat_messages',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['session_ref_id'] }],
  },
);

export class ParentChunk extends Model<InferAttributes<ParentChunk>, InferCreationAttributes<ParentChunk>> {
  declare chunkId: string;
  declare text: string;
  declare filename: string;
  declare fileType: string;
  declare filePath: string;
  declare pageNumber: number;
  declare parentChunkId: string;
  declare rootChunkId: string;
  declare chunkLevel: number;
  declare chunkIdx: number;
  declare updatedAt: CreationOptional<Date>;
}

ParentChunk.init(
  {
    chunkId: { type: DataTypes.STRING(512), primaryKey: true, field: 'chunk_id' },
    text: { type: DataTypes.TEXT, allowNull: false },
    filename: { type: DataTypes.STRING(255), allowNull: false },
    fileType: { type: DataTypes.STRING(50), allowNull: false, defaultValue: '', field: 'file_type' },
    filePath: { type: DataTypes.STRING(1024), allowNull: false, defaultValue: '', field: 'file_path' },
    pageNumber: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'page_number' },
    parentChunkId: { type: DataTypes.STRING(512), allowNull: false, defaultValue: '', field: 'parent_chunk_id' },
    rootChunkId: { type: DataTypes.STRING(512), allowNull: false, defaultValue: '', field: 'root_chunk_id' },
    chunkLevel: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'chunk_level' },
    chunkIdx: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0, field: 'chunk_idx' },
    updatedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW, field: 'updated_at' },
  },
  {
    sequelize,
    modelName: 'ParentChunk',
    tableName: 'parent_chunks',
    underscored: true,
    timestamps: false,
    indexes: [{ fields: ['filename'] }],
  },
);

User.hasMany(ChatSession, { foreignKey: 'user_id', as: 'sessions', onDelete: 'CASCADE' });
ChatSession.belongsTo(User, { foreignKey: 'user_id', as: 'user' });
ChatSession.hasMany(ChatMessage, { foreignKey: 'session_ref_id', as: 'messages', onDelete: 'CASCADE' });
ChatMessage.belongsTo(ChatSession, { foreignKey: 'session_ref_id', as: 'session' });

export const initDb = async (): Promise<void> => {
  await sequelize.authenticate();
  await sequelize.sync();
};
