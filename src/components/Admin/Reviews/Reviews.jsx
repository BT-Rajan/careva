import React, { useState } from 'react';
import AdminLayout from '../AdminLayout/AdminLayout';
import { Table, Card, Rate, Button, Modal, message, Avatar, Space, Tag, Input } from 'antd';
import { FaUser, FaUserMd, FaTrash, FaEye, FaCheck, FaFlag, FaBan } from 'react-icons/fa';
import { useGetAllReviewsForAdminQuery, useDeleteReviewMutation, usePublishReviewMutation, useFlagReviewMutation, useRemoveReviewMutation } from '../../../redux/api/reviewsApi';
import moment from 'moment';
import './Reviews.css';

const STATUS_TAG_COLOR = { SUBMITTED: 'gold', PUBLISHED: 'green', FLAGGED: 'orange', REMOVED: 'red' };

const AdminReviews = () => {
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);

    // Pass 21 — Admin & Operational Controls: this page's whole purpose is moderating
    // reviews, so it needs the admin queue (every status), not the public PUBLISHED-only
    // listing it was calling before.
    const { data, isLoading, refetch } = useGetAllReviewsForAdminQuery({ limit: pageSize, page });
    const [deleteReview, { isLoading: deleteLoading }] = useDeleteReviewMutation();
    const [publishReview, { isLoading: publishLoading }] = usePublishReviewMutation();
    const [flagReview, { isLoading: flagLoading }] = useFlagReviewMutation();
    const [removeReview, { isLoading: removeLoading }] = useRemoveReviewMutation();

    const reviews = data?.data || [];
    const meta = data?.meta || {};

    const handleDelete = (id) => {
        Modal.confirm({
            title: 'Delete Review',
            content: 'Are you sure you want to permanently delete this review? This cannot be undone — consider "Remove" instead if you may want to restore it later.',
            onOk: async () => {
                try {
                    // Pass 21 BUG FIX: this used to be a stub (`message.info('Delete
                    // review API needs proper implementation')`) — the mutation hook
                    // was imported but never actually called, because it was
                    // previously misclassified as a `build.query` (see reviewsApi.js).
                    await deleteReview(id).unwrap();
                    message.success('Review deleted successfully!');
                    refetch();
                } catch (error) {
                    message.error(error?.data?.message || 'Failed to delete review');
                }
            },
        });
    };

    const handleModerate = async (action, id) => {
        try {
            await action({ id }).unwrap();
            message.success('Review updated!');
        } catch (error) {
            message.error(error?.data?.message || 'Failed to update review');
        }
    };

    const handleViewDetails = (record) => {
        Modal.info({
            title: 'Review Details',
            width: 600,
            content: (
                <div className="review-details-modal">
                    <div className="review-header">
                        <Avatar src={record.patient?.img} icon={<FaUser />} size={60} />
                        <div>
                            <h4>{record.patient?.firstName} {record.patient?.lastName}</h4>
                            <Rate disabled value={record.star} />
                        </div>
                    </div>
                    <div className="review-content">
                        <p><strong>Doctor:</strong> Dr. {record.doctor?.firstName} {record.doctor?.lastName}</p>
                        <p><strong>Date:</strong> {moment(record.createdAt).format('MMM DD, YYYY')}</p>
                        <p><strong>Review:</strong></p>
                        <p className="review-text">{record.description}</p>
                        {record.reply && (
                            <>
                                <p><strong>Doctor Reply:</strong></p>
                                <p className="reply-text">{record.reply}</p>
                            </>
                        )}
                    </div>
                </div>
            ),
        });
    };

    const columns = [
        {
            title: 'Patient',
            key: 'patient',
            width: 200,
            render: (_, record) => (
                <div className="reviewer-info">
                    <Avatar 
                        src={record.patient?.img} 
                        icon={<FaUser />} 
                        size={40}
                    />
                    <div>
                        <div className="reviewer-name">
                            {record.patient?.firstName} {record.patient?.lastName}
                        </div>
                    </div>
                </div>
            ),
        },
        {
            title: 'Doctor',
            key: 'doctor',
            width: 200,
            render: (_, record) => (
                <div className="doctor-reviewed">
                    <FaUserMd className="icon-inline" />
                    Dr. {record.doctor?.firstName} {record.doctor?.lastName}
                </div>
            ),
        },
        {
            title: 'Rating',
            dataIndex: 'star',
            key: 'rating',
            width: 150,
            render: (star) => <Rate disabled value={star} />,
        },
        {
            title: 'Review',
            dataIndex: 'description',
            key: 'description',
            ellipsis: true,
        },
        {
            // Pass 21: this used to be labeled "Status" but actually showed whether the
            // doctor had replied ("Replied"/"Pending") — not a moderation status at
            // all, and there was no real one to show before this pass. Split into two
            // honestly-labeled columns.
            title: 'Moderation',
            key: 'status',
            width: 120,
            render: (_, record) => (
                <Tag color={STATUS_TAG_COLOR[record.status] || 'default'}>{record.status}</Tag>
            ),
        },
        {
            title: 'Doctor Reply',
            key: 'reply',
            width: 110,
            render: (_, record) => (
                <Tag color={record.response ? 'green' : 'default'}>
                    {record.response ? 'Replied' : 'None'}
                </Tag>
            ),
        },
        {
            title: 'Date',
            dataIndex: 'createdAt',
            key: 'date',
            width: 130,
            render: (date) => moment(date).format('MMM DD, YYYY'),
        },
        {
            title: 'Actions',
            key: 'actions',
            width: 220,
            fixed: 'right',
            render: (_, record) => (
                <Space wrap>
                    <Button
                        type="link"
                        icon={<FaEye />}
                        onClick={() => handleViewDetails(record)}
                        size="small"
                    />
                    {(record.status === 'SUBMITTED' || record.status === 'FLAGGED') && (
                        <Button
                            type="link"
                            icon={<FaCheck />}
                            title="Publish"
                            loading={publishLoading}
                            onClick={() => handleModerate(publishReview, record.id)}
                            size="small"
                        />
                    )}
                    {record.status === 'PUBLISHED' && (
                        <Button
                            type="link"
                            icon={<FaFlag />}
                            title="Flag"
                            loading={flagLoading}
                            onClick={() => handleModerate(flagReview, record.id)}
                            size="small"
                        />
                    )}
                    {record.status !== 'REMOVED' && (
                        <Button
                            type="link"
                            danger
                            icon={<FaBan />}
                            title="Remove"
                            loading={removeLoading}
                            onClick={() => handleModerate(removeReview, record.id)}
                            size="small"
                        />
                    )}
                    <Button
                        type="link"
                        danger
                        icon={<FaTrash />}
                        title="Delete permanently"
                        loading={deleteLoading}
                        onClick={() => handleDelete(record.id)}
                        size="small"
                    />
                </Space>
            ),
        },
    ];

    return (
        <AdminLayout title="Reviews" breadcrumbs={['Admin', 'Reviews']}>
            <Card className="admin-card">
                <Table
                    columns={columns}
                    dataSource={reviews}
                    rowKey="id"
                    loading={isLoading}
                    pagination={{
                        current: page,
                        pageSize,
                        total: meta.total || 0,
                        showSizeChanger: true,
                        showTotal: (total) => `Total ${total} reviews`,
                        onChange: (p, ps) => {
                            setPage(p);
                            setPageSize(ps);
                        },
                    }}
                    scroll={{ x: 1200 }}
                />
            </Card>
        </AdminLayout>
    );
};

export default AdminReviews;
