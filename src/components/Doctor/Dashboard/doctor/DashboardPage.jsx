import React, { useEffect, useState } from 'react'
import img from '../../../../images/avatar.jpg';
import { FaEye, FaCheck, FaTimes, FaBriefcaseMedical } from "react-icons/fa";
import { useGetDoctorAppointmentsQuery, useUpdateAppointmentMutation } from '../../../../redux/api/appointmentApi';
import moment from 'moment';
import { Button, Tag, message } from 'antd';
import CustomTable from '../../../UI/component/CustomTable';
import { Tabs } from 'antd';
import { Link } from 'react-router-dom';

const DashboardPage = () => {
    const [sortBy, setSortBy] = useState("upcoming");
    const { data, refetch, isLoading } = useGetDoctorAppointmentsQuery({ sortBy });
    const [updateAppointment, { isError, isSuccess, error }] = useUpdateAppointmentMutation();

    const handleOnselect = (value) => {
        // eslint-disable-next-line eqeqeq
        setSortBy(value == 1 ? 'upcoming' : value == 2 ? 'today' : sortBy)
        refetch()
    }


    const updatedApppointmentStatus = (data, type) => {
        // Pass 8: previously sent the literal strings 'accept'/'cancel' — 'accept' never
        // matched any status value used anywhere else in the app (Doctor/Appointments/
        // Appointments.jsx's equivalent button sent 'scheduled' for the same action), and
        // 'cancel' was used for both "decline a pending request" and "cancel an already-
        // scheduled appointment," two different states in the real state machine. Now
        // sends the actual target AppointmentStatus enum value, matching Pass 4's
        // context-aware Cancel button in Doctor/Appointments/Appointments.jsx.
        const target = type === 'accept'
            ? 'SCHEDULED'
            : data.status === 'PENDING' ? 'DECLINED' : 'CANCELLED_BY_DOCTOR';
        const changeObj = {
            status: target
        }
        if (data.id) {
            updateAppointment({ id: data.id, data: changeObj })
        }
    }

    useEffect(() => {
        if (isSuccess) {
            message.success("Succcessfully Appointment Updated")
        }
        if (isError) {
            message.error(error?.data?.message);
        }
    }, [isSuccess, isError, error])

    const upcomingColumns = [
        {
            title: 'Patient Name',
            key: '1',
            width: 100,
            render: function (data) {
                const fullName = `${data?.patient?.firstName ?? ''} ${data?.patient?.lastName ?? ''}`;
                const patientName = fullName.trim() || "Un Patient";
                const imgdata = data?.patient?.img ? data?.patient?.img : img
                return <>
                    <div className="table-avatar">
                        <a className="avatar avatar-sm mr-2 d-flex gap-2">
                            <img className="avatar-img rounded-circle" src={imgdata} alt="" />
                            <div>
                                <p className='p-0 m-0 text-nowrap'>
                                    {patientName}
                                </p>
                                <p className='p-0 m-0'>{data?.patient?.designation}</p>
                            </div>
                        </a>
                    </div>
                </>
            }
        },
        {
            title: 'App Date',
            key: '2',
            width: 100,
            render: function (data) {
                return (
                    <div>{moment(data?.scheduleDate).format("LL")} <span className="d-block text-info">{data?.scheduleTime}</span></div>
                )
            }
        },
        {
            title: 'Status',
            key: '4',
            width: 100,
            render: function (data) {
                return (
                    <Tag color="#87d068" className='text-uppercase'>{data?.status}</Tag>
                )
            }
        },
        {
            title: 'Action',
            key: '5',
            width: 100,
            render: function (data) {
                return (
                    <div className='d-flex gap-2'>
                        {
                            data.prescriptionStatus === 'notIssued'
                                ?
                                <Link to={`/dashboard/appointment/treatment/${data?.id}`}>
                                    <Button type="primary" icon={<FaBriefcaseMedical />} size="small">Treatment</Button>
                                </Link>

                                :
                                <Link to={`/dashboard/prescription/${data?.prescription[0]?.id}`}>
                                    <Button type="primary" shape="circle" icon={<FaEye />} size="small" />
                                </Link>
                        }
                        {
                            data?.status === 'PENDING' &&
                            <>
                                <Button type="primary" icon={<FaCheck />} size="small" onClick={() => updatedApppointmentStatus(data, 'accept')}>Accept</Button>
                                <Button type='primary' icon={<FaTimes />} size='small' danger onClick={() => updatedApppointmentStatus(data, 'cancel')}>Cancel</Button>
                            </>
                        }
                    </div>
                )
            }
        },
    ];

    const items = [
        {
            key: '1',
            label: 'upcoming',
            children: <CustomTable
                loading={isLoading}
                columns={upcomingColumns}
                dataSource={data}
                showPagination={true}
                pageSize={10}
                showSizeChanger={true}
            />,
        },
        {
            key: '2',
            label: 'today',
            children: <CustomTable
                loading={isLoading}
                columns={upcomingColumns}
                dataSource={data}
                showPagination={true}
                pageSize={10}
                showSizeChanger={true}
            />,
        },
    ];

    return (
        <Tabs defaultActiveKey="1" items={items} onChange={handleOnselect} />
    )
}

export default DashboardPage;